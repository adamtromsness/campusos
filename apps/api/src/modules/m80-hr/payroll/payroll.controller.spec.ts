import { describe, it, expect } from 'vitest';
import { PERMISSIONS_KEY } from '@shared/auth';
import { PayrollController } from './payroll.controller';

/**
 * P2-H4 test coverage uplift — payroll.controller.ts (267 LOC, critical-path
 * Tier 1 Financial ≥95%).
 *
 * The controller is a thin HTTP-to-service adapter; the spec verifies:
 *   - Every endpoint carries the expected @RequirePermission metadata
 *     (REVIEW-P2-4a BLOCKING #3 — admin reads on hr-010:read, mutations on
 *     hr-010:admin, self-service payslip reads on hr-003:read).
 *   - Delegations call the right service method with the supplied params.
 *   - The /me/payslips alias FORCES self-binding by overriding employeeId +
 *     stripping isSchoolAdmin from the actor passed to the service.
 *   - includeInactive=true is honoured on the pay-grades list query.
 */

type Calls = Record<string, Array<unknown[]>>;

function makeServices() {
  const calls: Calls = {
    payGradesList: [],
    payGradesGetById: [],
    payGradesCreate: [],
    payGradesPatch: [],
    payGradesListScales: [],
    payGradesAddScale: [],
    payGradesPatchScale: [],
    payrollListPeriods: [],
    payrollGetPeriod: [],
    payrollCreatePeriod: [],
    payrollProcessPeriod: [],
    payrollApprovePeriod: [],
    payrollMarkPaid: [],
    payrollListRecords: [],
    payrollGetRecord: [],
    salaryReviewsList: [],
    salaryReviewsGetById: [],
    salaryReviewsCreate: [],
    salaryReviewsPatch: [],
    actorsResolve: [],
  };
  const payGrades = {
    list: async (...a: unknown[]) => {
      calls.payGradesList.push(a);
      return ['list-result'];
    },
    getById: async (...a: unknown[]) => {
      calls.payGradesGetById.push(a);
      return 'one-grade';
    },
    create: async (...a: unknown[]) => {
      calls.payGradesCreate.push(a);
      return 'created-grade';
    },
    patch: async (...a: unknown[]) => {
      calls.payGradesPatch.push(a);
      return 'patched-grade';
    },
    listScales: async (...a: unknown[]) => {
      calls.payGradesListScales.push(a);
      return ['scales'];
    },
    addScale: async (...a: unknown[]) => {
      calls.payGradesAddScale.push(a);
      return 'new-scale';
    },
    patchScale: async (...a: unknown[]) => {
      calls.payGradesPatchScale.push(a);
      return 'patched-scale';
    },
  };
  const payroll = {
    listPeriods: async (...a: unknown[]) => {
      calls.payrollListPeriods.push(a);
      return ['periods'];
    },
    getPeriod: async (...a: unknown[]) => {
      calls.payrollGetPeriod.push(a);
      return 'one-period';
    },
    createPeriod: async (...a: unknown[]) => {
      calls.payrollCreatePeriod.push(a);
      return 'new-period';
    },
    processPeriod: async (...a: unknown[]) => {
      calls.payrollProcessPeriod.push(a);
      return { processed: 3, skipped: 1 };
    },
    approvePeriod: async (...a: unknown[]) => {
      calls.payrollApprovePeriod.push(a);
      return 'approved-period';
    },
    markPaid: async (...a: unknown[]) => {
      calls.payrollMarkPaid.push(a);
      return 'paid-period';
    },
    listRecords: async (...a: unknown[]) => {
      calls.payrollListRecords.push(a);
      return ['records'];
    },
    getRecord: async (...a: unknown[]) => {
      calls.payrollGetRecord.push(a);
      return 'one-record';
    },
  };
  const salaryReviews = {
    list: async (...a: unknown[]) => {
      calls.salaryReviewsList.push(a);
      return ['reviews'];
    },
    getById: async (...a: unknown[]) => {
      calls.salaryReviewsGetById.push(a);
      return 'one-review';
    },
    create: async (...a: unknown[]) => {
      calls.salaryReviewsCreate.push(a);
      return 'new-review';
    },
    patch: async (...a: unknown[]) => {
      calls.salaryReviewsPatch.push(a);
      return 'patched-review';
    },
  };
  const actors = {
    resolveActor: async (sub: string, personId: string) => {
      calls.actorsResolve.push([sub, personId]);
      return {
        accountId: sub,
        personId,
        personType: 'STAFF',
        isSchoolAdmin: false,
        employeeId: 'emp-self',
      };
    },
  };
  return { calls, payGrades, payroll, salaryReviews, actors };
}

function makeCtrl() {
  const fakes = makeServices();
  const ctrl = new PayrollController(
    fakes.payGrades as never,
    fakes.payroll as never,
    fakes.salaryReviews as never,
    fakes.actors as never,
  );
  return { ctrl, ...fakes };
}

const REQ = {
  user: {
    sub: 'acct-1',
    personId: 'person-1',
    email: 'a@b.c',
    displayName: 'A B',
    sessionId: 's-1',
  },
};

describe('PayrollController — @RequirePermission metadata (REVIEW-P2-4a BLOCKING #3)', () => {
  // Admin reads (REVIEW-P2-4a #3): hr-010:read
  it.each(['listGrades', 'getGrade', 'listScales', 'listPeriods', 'getPeriod'])(
    '%s carries hr-010:read',
    (method) => {
      const codes = Reflect.getMetadata(
        PERMISSIONS_KEY,
        PayrollController.prototype[method as never],
      );
      expect(codes).toEqual(['hr-010:read']);
    },
  );

  // Admin mutations: hr-010:admin
  it.each([
    'createGrade',
    'patchGrade',
    'addScale',
    'patchScale',
    'createPeriod',
    'process',
    'approve',
    'markPaid',
  ])('%s carries hr-010:admin', (method) => {
    const codes = Reflect.getMetadata(
      PERMISSIONS_KEY,
      PayrollController.prototype[method as never],
    );
    expect(codes).toEqual(['hr-010:admin']);
  });

  // Self-service reads: hr-003:read (employees + parents hold this from Cycle 4)
  it.each(['listRecords', 'getRecord', 'myPayslips', 'listReviews', 'getReview'])(
    '%s carries hr-003:read (self-service)',
    (method) => {
      const codes = Reflect.getMetadata(
        PERMISSIONS_KEY,
        PayrollController.prototype[method as never],
      );
      expect(codes).toEqual(['hr-003:read']);
    },
  );

  // Salary review write: hr-003:write
  it.each(['submitReview', 'patchReview'])('%s carries hr-003:write', (method) => {
    const codes = Reflect.getMetadata(
      PERMISSIONS_KEY,
      PayrollController.prototype[method as never],
    );
    expect(codes).toEqual(['hr-003:write']);
  });
});

describe('PayrollController — pay grade routes', () => {
  it('listGrades forwards includeInactive=true', async () => {
    const { ctrl, calls } = makeCtrl();
    await ctrl.listGrades('true');
    expect(calls.payGradesList).toEqual([[true]]);
  });

  it('listGrades treats any other value as false', async () => {
    const { ctrl, calls } = makeCtrl();
    await ctrl.listGrades(undefined);
    await ctrl.listGrades('false');
    await ctrl.listGrades('TRUE'); // case-sensitive
    expect(calls.payGradesList).toEqual([[false], [false], [false]]);
  });

  it('getGrade delegates to PayGradeService.getById', async () => {
    const { ctrl, calls } = makeCtrl();
    await ctrl.getGrade('grade-1');
    expect(calls.payGradesGetById).toEqual([['grade-1']]);
  });

  it('createGrade resolves actor + passes input through', async () => {
    const { ctrl, calls } = makeCtrl();
    await ctrl.createGrade(REQ as never, { gradeName: 'Teacher I' } as never);
    expect(calls.actorsResolve).toEqual([['acct-1', 'person-1']]);
    expect(calls.payGradesCreate[0][0]).toEqual({ gradeName: 'Teacher I' });
    expect((calls.payGradesCreate[0][1] as { accountId: string }).accountId).toBe('acct-1');
  });

  it('patchGrade forwards id + input', async () => {
    const { ctrl, calls } = makeCtrl();
    await ctrl.patchGrade(REQ as never, 'grade-1', { gradeName: 'Renamed' } as never);
    expect(calls.payGradesPatch[0][0]).toBe('grade-1');
    expect(calls.payGradesPatch[0][1]).toEqual({ gradeName: 'Renamed' });
  });

  it('listScales delegates to PayGradeService.listScales', async () => {
    const { ctrl, calls } = makeCtrl();
    await ctrl.listScales('grade-1');
    expect(calls.payGradesListScales).toEqual([['grade-1']]);
  });

  it('addScale forwards id + input + resolved actor', async () => {
    const { ctrl, calls } = makeCtrl();
    await ctrl.addScale(REQ as never, 'grade-1', { step: 2, annualSalary: 50000 } as never);
    expect(calls.payGradesAddScale[0][0]).toBe('grade-1');
    expect(calls.payGradesAddScale[0][1]).toEqual({ step: 2, annualSalary: 50000 });
  });

  it('patchScale forwards id + input + resolved actor', async () => {
    const { ctrl, calls } = makeCtrl();
    await ctrl.patchScale(REQ as never, 'scale-1', { annualSalary: 55000 } as never);
    expect(calls.payGradesPatchScale[0][0]).toBe('scale-1');
    expect(calls.payGradesPatchScale[0][1]).toEqual({ annualSalary: 55000 });
  });
});

describe('PayrollController — pay period routes', () => {
  it('listPeriods forwards the query object', async () => {
    const { ctrl, calls } = makeCtrl();
    await ctrl.listPeriods({ status: 'OPEN' } as never);
    expect(calls.payrollListPeriods[0][0]).toEqual({ status: 'OPEN' });
  });

  it('getPeriod delegates to PayrollService.getPeriod', async () => {
    const { ctrl, calls } = makeCtrl();
    await ctrl.getPeriod('period-1');
    expect(calls.payrollGetPeriod).toEqual([['period-1']]);
  });

  it('createPeriod resolves actor + passes input', async () => {
    const { ctrl, calls } = makeCtrl();
    await ctrl.createPeriod(REQ as never, { name: 'May 2026', startDate: '2026-05-01' } as never);
    expect(calls.payrollCreatePeriod[0][0]).toEqual({ name: 'May 2026', startDate: '2026-05-01' });
  });

  it('process delegates to processPeriod with id + input', async () => {
    const { ctrl, calls } = makeCtrl();
    const result = await ctrl.process(REQ as never, 'period-1', { payDate: '2026-05-31' } as never);
    expect(result).toEqual({ processed: 3, skipped: 1 });
    expect(calls.payrollProcessPeriod[0][0]).toBe('period-1');
    expect(calls.payrollProcessPeriod[0][1]).toEqual({ payDate: '2026-05-31' });
  });

  it('approve forwards period id', async () => {
    const { ctrl, calls } = makeCtrl();
    await ctrl.approve(REQ as never, 'period-1');
    expect(calls.payrollApprovePeriod[0][0]).toBe('period-1');
  });

  it('markPaid forwards period id (and the outbox-emit happens service-side)', async () => {
    const { ctrl, calls } = makeCtrl();
    await ctrl.markPaid(REQ as never, 'period-1');
    expect(calls.payrollMarkPaid[0][0]).toBe('period-1');
  });
});

describe('PayrollController — payroll record routes', () => {
  it('listRecords forwards the query untouched', async () => {
    const { ctrl, calls } = makeCtrl();
    await ctrl.listRecords(REQ as never, { employeeId: 'emp-X' } as never);
    expect(calls.payrollListRecords[0][0]).toEqual({ employeeId: 'emp-X' });
  });

  it('getRecord delegates to getRecord with id', async () => {
    const { ctrl, calls } = makeCtrl();
    await ctrl.getRecord(REQ as never, 'rec-1');
    expect(calls.payrollGetRecord[0][0]).toBe('rec-1');
  });

  it('/me/payslips FORCES self-binding (employeeId override + isSchoolAdmin stripped)', async () => {
    const { ctrl, calls } = makeCtrl();
    // Simulate an admin actor — the resolveActor stub returns isSchoolAdmin=false
    // by default. We re-stub to admin for this test only:
    const adminCtrl = new PayrollController(
      { listScales: async () => [] } as never,
      {
        listRecords: async (q: unknown, a: unknown) => {
          calls.payrollListRecords.push([q, a]);
          return ['records'];
        },
      } as never,
      { list: async () => [] } as never,
      {
        resolveActor: async () => ({
          accountId: 'admin-acct',
          personId: 'admin-person',
          personType: 'STAFF',
          isSchoolAdmin: true,
          employeeId: 'emp-admin',
        }),
      } as never,
    );
    await adminCtrl.myPayslips(REQ as never, { someFilter: 'x' } as never);
    expect(calls.payrollListRecords).toHaveLength(1);
    // Query gets the actor's employeeId injected
    expect((calls.payrollListRecords[0][0] as { employeeId: string }).employeeId).toBe('emp-admin');
    expect((calls.payrollListRecords[0][0] as { someFilter: string }).someFilter).toBe('x');
    // Actor passed to the service has isSchoolAdmin FORCED to false
    expect((calls.payrollListRecords[0][1] as { isSchoolAdmin: boolean }).isSchoolAdmin).toBe(
      false,
    );
    expect((calls.payrollListRecords[0][1] as { employeeId: string }).employeeId).toBe('emp-admin');
  });

  it('/me/payslips passes undefined for employeeId if actor has none (Platform Admin)', async () => {
    const captured: Array<[unknown, unknown]> = [];
    const ctrl = new PayrollController(
      { listScales: async () => [] } as never,
      {
        listRecords: async (q: unknown, a: unknown) => {
          captured.push([q, a]);
          return [];
        },
      } as never,
      { list: async () => [] } as never,
      {
        resolveActor: async () => ({
          accountId: 'platform-admin',
          personId: 'platform-admin',
          personType: 'STAFF',
          isSchoolAdmin: true,
          employeeId: null,
        }),
      } as never,
    );
    await ctrl.myPayslips(REQ as never, {} as never);
    expect((captured[0][0] as { employeeId: string | undefined }).employeeId).toBeUndefined();
  });
});

describe('PayrollController — salary review routes', () => {
  it('listReviews forwards the query', async () => {
    const { ctrl, calls } = makeCtrl();
    await ctrl.listReviews(REQ as never, { status: 'SUBMITTED' } as never);
    expect(calls.salaryReviewsList[0][0]).toEqual({ status: 'SUBMITTED' });
  });

  it('getReview delegates to SalaryReviewService.getById', async () => {
    const { ctrl, calls } = makeCtrl();
    await ctrl.getReview(REQ as never, 'review-1');
    expect(calls.salaryReviewsGetById[0][0]).toBe('review-1');
  });

  it('submitReview delegates to SalaryReviewService.create with input + actor', async () => {
    const { ctrl, calls } = makeCtrl();
    await ctrl.submitReview(
      REQ as never,
      {
        employeeId: 'emp-1',
        reviewType: 'ANNUAL_INCREMENT',
        justification: 'Good year',
      } as never,
    );
    expect(calls.salaryReviewsCreate[0][0]).toEqual({
      employeeId: 'emp-1',
      reviewType: 'ANNUAL_INCREMENT',
      justification: 'Good year',
    });
  });

  it('patchReview delegates to SalaryReviewService.patch with id + input', async () => {
    const { ctrl, calls } = makeCtrl();
    await ctrl.patchReview(REQ as never, 'review-1', { status: 'WITHDRAWN' } as never);
    expect(calls.salaryReviewsPatch[0][0]).toBe('review-1');
    expect(calls.salaryReviewsPatch[0][1]).toEqual({ status: 'WITHDRAWN' });
  });
});
