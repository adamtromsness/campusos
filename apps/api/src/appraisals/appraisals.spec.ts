import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { runWithTenantContext } from '../tenant/tenant.context';
import { PERMISSIONS_KEY } from '../auth/require-permission.decorator';
import {
  AppraisalCommentService,
  AppraisalGoalService,
  AppraisalService,
  LessonObservationService,
} from './appraisals.service';
import { ExpenseClaimService } from './expense-claim.service';
import { AppraisalsController } from './appraisals.controller';

const SCHOOL = { schoolId: '019e0cf8-bbb8-7556-8c81-aaaaaaaaaaaa', subdomain: 'demo' } as never;
const ADMIN_ACTOR = {
  accountId: '019e0cf8-bbb8-7556-8c81-a0000000a001',
  personId: '019e0cf8-bbb8-7556-8c81-a0000000a002',
  employeeId: '019e0cf8-bbb8-7556-8c81-a0000000a003',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
} as never;
const STAFF_ACTOR = {
  accountId: '019e0cf8-bbb8-7556-8c81-c0000000c001',
  personId: '019e0cf8-bbb8-7556-8c81-c0000000c002',
  employeeId: '019e0cf8-bbb8-7556-8c81-c0000000c003',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
} as never;
const TEACHER_ACTOR = {
  accountId: '019e0cf8-bbb8-7556-8c81-b0000000b001',
  personId: '019e0cf8-bbb8-7556-8c81-b0000000b002',
  employeeId: '019e0cf8-bbb8-7556-8c81-b0000000b003',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
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

describe('AppraisalService — SIGNED_OFF immutability keystone', () => {
  it('refuses any patch when status=SIGNED_OFF', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update')) {
        return [
          {
            id: 'a-1',
            status: 'SIGNED_OFF',
            employee_id: 'emp-1',
          },
        ];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const svc = new AppraisalService(fake.tenantPrisma as never, permissions as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.patch('a-1', { selfReview: 'edit attempt' }, ADMIN_ACTOR),
      ),
    ).rejects.toThrow(/SIGNED_OFF/);
    // No UPDATE INTO hr_appraisals should have fired.
    const updateCall = fake.capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('update hr_appraisals'),
    );
    expect(updateCall).toBeUndefined();
  });

  it('on transition to SIGNED_OFF stamps signed_off_at + signed_off_by atomically', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update')) {
        return [
          {
            id: 'a-1',
            status: 'IN_REVIEW',
            employee_id: 'emp-1',
          },
        ];
      }
      if (sql.includes('from hr_appraisals a')) {
        return [
          {
            id: 'a-1',
            cycle_id: 'cyc-1',
            cycle_name: 'AY2025',
            cycle_type: 'ANNUAL',
            employee_id: 'emp-1',
            employee_first: 'James',
            employee_last: 'Rivera',
            appraiser_id: 'app-1',
            appraiser_first: null,
            appraiser_last: null,
            school_id: SCHOOL.schoolId,
            overall_rating: 'GOOD',
            self_review: null,
            appraiser_review: null,
            development_plan: null,
            status: 'SIGNED_OFF',
            signed_off_at: '2026-05-09T00:00:00Z',
            signed_off_by: ADMIN_ACTOR.employeeId,
            signed_off_by_first: 'Sarah',
            signed_off_by_last: 'Mitchell',
            linked_approval_id: null,
            created_at: '2026-04-01T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const svc = new AppraisalService(fake.tenantPrisma as never, permissions as never);
    const dto = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.patch('a-1', { status: 'SIGNED_OFF' }, ADMIN_ACTOR),
    );
    expect(dto.status).toBe('SIGNED_OFF');
    // The UPDATE call must have set signed_off_at = now() AND
    // signed_off_by = $actor.employeeId in the same statement.
    const updateCall = fake.capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('update hr_appraisals set'),
    );
    expect(updateCall).toBeTruthy();
    expect(updateCall!.sql.toLowerCase()).toContain('signed_off_at = now()');
    expect(updateCall!.args).toContain(ADMIN_ACTOR.employeeId);
  });

  it('non-admin appraisee can only edit selfReview, not appraiserReview', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update')) {
        return [
          {
            id: 'a-1',
            status: 'DRAFT',
            employee_id: TEACHER_ACTOR.employeeId,
          },
        ];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const svc = new AppraisalService(fake.tenantPrisma as never, permissions as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.patch('a-1', { appraiserReview: 'employee-injected text' }, TEACHER_ACTOR),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('LessonObservationService — lesson_observation:write keystone', () => {
  it('Staff with hr-005:write but NOT lesson_observation:write is rejected with Forbidden', async () => {
    const fake = makeFake(() => []);
    // Staff actor has hr-005 but NOT lesson_observation. The
    // permission check helper must distinguish: this stub returns
    // false for the lesson_observation: code group.
    const permissions = {
      hasAnyPermissionInTenant: async (_accountId: string, _schoolId: string, codes: string[]) => {
        // Only lesson_observation codes return false; everything
        // else returns true (so the broader hr-005 check passes).
        return !codes.some((c) => c.startsWith('lesson_observation'));
      },
    };
    const appraisals = new AppraisalService(fake.tenantPrisma as never, permissions as never);
    const svc = new LessonObservationService(
      fake.tenantPrisma as never,
      permissions as never,
      appraisals,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create(
          {
            observedEmployeeId: 'emp-1',
            observationDate: '2026-05-09',
            observedClassLabel: 'Algebra 1 — P3',
          },
          STAFF_ACTOR,
        ),
      ),
    ).rejects.toThrow(/lesson_observation:write/);
  });

  it('admin (isSchoolAdmin=true) reaches the create path; INSERT INTO hr_lesson_observations runs', async () => {
    const empId = '019e0e69-aaaa-7000-8000-0000aaaaaaaa';
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      // observed employee tenant validation
      if (
        sql.includes('from hr_employees') &&
        sql.includes('school_id') &&
        sql.includes('limit 1')
      ) {
        return [{ id: empId }];
      }
      // final reload
      if (sql.includes('from hr_lesson_observations o') && !sql.includes('for update')) {
        return [
          {
            id: 'obs-1',
            appraisal_id: null,
            school_id: SCHOOL.schoolId,
            observer_id: ADMIN_ACTOR.employeeId,
            observer_first: 'Sarah',
            observer_last: 'Mitchell',
            observed_employee_id: empId,
            observed_first: 'James',
            observed_last: 'Rivera',
            observation_date: '2026-05-09',
            observed_class_label: 'Algebra 1 — P3',
            observed_class_id: null,
            duration_minutes: 45,
            overall_grade: 'GOOD',
            strengths: 'Clear pacing',
            areas_for_development: 'Differentiation',
            notes: null,
            is_locked: false,
            locked_at: null,
            locked_by: null,
            created_at: '2026-05-09T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const appraisals = new AppraisalService(fake.tenantPrisma as never, permissions as never);
    const svc = new LessonObservationService(
      fake.tenantPrisma as never,
      permissions as never,
      appraisals,
    );
    const dto = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.create(
        {
          observedEmployeeId: empId,
          observationDate: '2026-05-09',
          observedClassLabel: 'Algebra 1 — P3',
          durationMinutes: 45,
          overallGrade: 'GOOD',
          strengths: 'Clear pacing',
          areasForDevelopment: 'Differentiation',
        },
        ADMIN_ACTOR,
      ),
    );
    expect(dto.observedClassLabel).toBe('Algebra 1 — P3');
    const insert = fake.capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into hr_lesson_observations'),
    );
    expect(insert).toBeTruthy();
  });

  it('lock() refuses second-lock attempt with friendly 400', async () => {
    let callCount = 0;
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update')) {
        callCount += 1;
        return [{ id: 'obs-1', is_locked: true }];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const appraisals = new AppraisalService(fake.tenantPrisma as never, permissions as never);
    const svc = new LessonObservationService(
      fake.tenantPrisma as never,
      permissions as never,
      appraisals,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () => svc.lock('obs-1', ADMIN_ACTOR)),
    ).rejects.toThrow(/already locked/);
    expect(callCount).toBe(1);
  });
});

describe('ExpenseClaimService — approval lockstep', () => {
  it('decide() REJECTED requires non-empty rejectionReason', async () => {
    const fake = makeFake(() => []);
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const svc = new ExpenseClaimService(fake.tenantPrisma as never, permissions as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.decide('cl-1', { decision: 'REJECTED', rejectionReason: '' }, ADMIN_ACTOR),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('decide() refuses non-SUBMITTED claims with friendly 400', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update')) {
        return [{ id: 'cl-1', status: 'APPROVED' }];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const svc = new ExpenseClaimService(fake.tenantPrisma as never, permissions as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.decide('cl-1', { decision: 'APPROVED' }, ADMIN_ACTOR),
      ),
    ).rejects.toThrow(/Only SUBMITTED claims/);
  });

  it('markPaid() refuses non-APPROVED claims with friendly 400', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update')) {
        return [{ id: 'cl-1', status: 'SUBMITTED' }];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const svc = new ExpenseClaimService(fake.tenantPrisma as never, permissions as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () => svc.markPaid('cl-1', {}, ADMIN_ACTOR)),
    ).rejects.toThrow(/Only APPROVED claims/);
  });
});

// Suppress unused-import warning for services exercised only by
// controller-metadata tests below.
void AppraisalGoalService;
void AppraisalCommentService;

describe('AppraisalsController — permission gate distribution', () => {
  const proto = AppraisalsController.prototype as unknown as Record<string, () => unknown>;
  function gateFor(methodName: string): string[] {
    return Reflect.getMetadata(PERMISSIONS_KEY, proto[methodName]!) ?? [];
  }
  it('appraisal admin endpoints carry hr-005:write; reads carry hr-005:read', () => {
    expect(gateFor('listFrameworks')).toEqual(['hr-005:read']);
    expect(gateFor('createFramework')).toEqual(['hr-005:write']);
    expect(gateFor('listCycles')).toEqual(['hr-005:read']);
    expect(gateFor('createCycle')).toEqual(['hr-005:write']);
    expect(gateFor('listAppraisals')).toEqual(['hr-005:read']);
    expect(gateFor('createAppraisal')).toEqual(['hr-005:write']);
    expect(gateFor('patchAppraisal')).toEqual(['hr-005:read']);
  });

  it('lesson observation endpoints carry lesson_observation:write — KEYSTONE', () => {
    expect(gateFor('createObservation')).toEqual(['lesson_observation:write']);
    expect(gateFor('patchObservation')).toEqual(['lesson_observation:write']);
    expect(gateFor('lockObservation')).toEqual(['lesson_observation:write']);
    // List read uses hr-005:read because the observed employee
    // can see their own locked observations through it.
    expect(gateFor('listEmployeeObservations')).toEqual(['hr-005:read']);
  });

  it('expense-claim endpoints carry hr-012 codes', () => {
    expect(gateFor('listClaims')).toEqual(['hr-012:read']);
    expect(gateFor('createClaim')).toEqual(['hr-012:write']);
    expect(gateFor('decideClaim')).toEqual(['hr-012:write']);
    expect(gateFor('markPaid')).toEqual(['hr-012:write']);
  });
});
