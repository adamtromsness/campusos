import { describe, it, expect } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '@shared/tenant';
import { SalaryReviewService } from './salary-review.service';

/**
 * P2-H4 test coverage uplift — salary-review.service.ts (294 LOC,
 * critical-path Tier 1 Financial ≥95%).
 *
 * SalaryReviewService owns the hr_salary_review_requests workflow.
 *
 * Authority model (REVIEW-P2-4a BLOCKING #3): hr-010:admin / hr-010:write
 * (Payroll Management) is the admin authority. Requesters need any
 * authenticated identity (actor.personId). Reviews become IMMUTABLE once
 * APPROVED or REJECTED. WITHDRAWN is requester-or-admin; status flips to
 * UNDER_REVIEW / APPROVED / REJECTED are admin-only.
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

const ADMIN = {
  accountId: 'acct-admin',
  personId: 'person-admin',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
  employeeId: 'emp-admin',
} as never;

const REQUESTER = {
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

const PENDING_REVIEW = {
  id: 'review-1',
  school_id: SCHOOL.schoolId,
  employee_id: 'emp-1',
  employee_first: 'James',
  employee_last: 'Rivera',
  requested_by: REQUESTER.personId,
  requestor_first: 'Sarah',
  requestor_last: 'Mitchell',
  review_type: 'ANNUAL',
  current_salary: '50000.00',
  recommended_salary: '55000.00',
  effective_date: '2026-09-01',
  justification: 'Strong performance review',
  status: 'SUBMITTED',
  decision_notes: null,
  decided_by: null,
  decided_at: null,
  created_at: '2026-05-01T00:00:00Z',
};

describe('SalaryReviewService.list', () => {
  it('admin sees all reviews in the tenant', async () => {
    const fake = makeFake(() => [PENDING_REVIEW]);
    const svc = new SalaryReviewService(fake.tenantPrisma as never, makePerm() as never);
    const result = await runWithTenantContext({ tenant: SCHOOL }, () => svc.list({}, ADMIN));
    expect(result).toHaveLength(1);
    expect(fake.capture[0].sql).toContain('WHERE r.school_id = $1::uuid');
    expect(fake.capture[0].sql).not.toContain('OR r.employee_id');
  });

  it('non-admin requester sees own submissions + own-employee reviews via OR clause', async () => {
    const fake = makeFake(() => [PENDING_REVIEW]);
    const svc = new SalaryReviewService(fake.tenantPrisma as never, makePerm() as never);
    await runWithTenantContext({ tenant: SCHOOL }, () => svc.list({}, REQUESTER));
    expect(fake.capture[0].sql).toContain('r.requested_by = $');
    expect(fake.capture[0].sql).toContain('r.employee_id = $');
    expect(fake.capture[0].args).toContain(REQUESTER.personId);
    expect(fake.capture[0].args).toContain(REQUESTER.employeeId);
  });

  it('non-admin without personId or employeeId gets [] without any DB query', async () => {
    const fake = makeFake(() => []);
    const svc = new SalaryReviewService(fake.tenantPrisma as never, makePerm() as never);
    const anon = { ...REQUESTER, personId: '', employeeId: null } as never;
    const result = await runWithTenantContext({ tenant: SCHOOL }, () => svc.list({}, anon));
    expect(result).toEqual([]);
    expect(fake.capture).toHaveLength(0);
  });

  it('appends status filter to the WHERE clause', async () => {
    const fake = makeFake(() => []);
    const svc = new SalaryReviewService(fake.tenantPrisma as never, makePerm() as never);
    await runWithTenantContext({ tenant: SCHOOL }, () => svc.list({ status: 'APPROVED' }, ADMIN));
    expect(fake.capture[0].sql).toContain('r.status = $');
    expect(fake.capture[0].args).toContain('APPROVED');
  });

  it('appends employeeId filter to the WHERE clause', async () => {
    const fake = makeFake(() => []);
    const svc = new SalaryReviewService(fake.tenantPrisma as never, makePerm() as never);
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.list({ employeeId: 'emp-target' }, ADMIN),
    );
    expect(fake.capture[0].sql).toContain('r.employee_id = $');
    expect(fake.capture[0].args).toContain('emp-target');
  });

  it('hr-010:write actor is treated as admin (sees all)', async () => {
    const fake = makeFake(() => [PENDING_REVIEW]);
    const svc = new SalaryReviewService(
      fake.tenantPrisma as never,
      makePerm({ 'hr-010:write': true }) as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, () => svc.list({}, REQUESTER));
    expect(fake.capture[0].sql).not.toContain('OR r.employee_id');
  });

  it('orders results by created_at DESC', async () => {
    const fake = makeFake(() => []);
    const svc = new SalaryReviewService(fake.tenantPrisma as never, makePerm() as never);
    await runWithTenantContext({ tenant: SCHOOL }, () => svc.list({}, ADMIN));
    expect(fake.capture[0].sql).toContain('ORDER BY r.created_at DESC');
  });
});

describe('SalaryReviewService.getById', () => {
  it('admin reads any review in tenant', async () => {
    const fake = makeFake(() => [PENDING_REVIEW]);
    const svc = new SalaryReviewService(fake.tenantPrisma as never, makePerm() as never);
    const result = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.getById('review-1', ADMIN),
    );
    expect(result.id).toBe('review-1');
    expect(result.recommendedSalary).toBe(55000);
  });

  it('requester reads own submission', async () => {
    const fake = makeFake(() => [PENDING_REVIEW]);
    const svc = new SalaryReviewService(fake.tenantPrisma as never, makePerm() as never);
    const result = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.getById('review-1', REQUESTER),
    );
    expect(result.id).toBe('review-1');
  });

  it('subject employee (employeeId match) reads own review', async () => {
    const fake = makeFake(() => [
      { ...PENDING_REVIEW, requested_by: 'other-person', employee_id: REQUESTER.employeeId },
    ]);
    const svc = new SalaryReviewService(fake.tenantPrisma as never, makePerm() as never);
    const result = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.getById('review-1', REQUESTER),
    );
    expect(result.id).toBe('review-1');
  });

  it("non-admin / non-requester / non-employee gets 404 (don't-leak-existence)", async () => {
    const fake = makeFake(() => [
      { ...PENDING_REVIEW, requested_by: 'other-person', employee_id: 'other-employee' },
    ]);
    const svc = new SalaryReviewService(fake.tenantPrisma as never, makePerm() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () => svc.getById('review-1', REQUESTER)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 404 when no row exists in tenant', async () => {
    const fake = makeFake(() => []);
    const svc = new SalaryReviewService(fake.tenantPrisma as never, makePerm() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () => svc.getById('missing', ADMIN)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns null for null current/recommended salary + composed names', async () => {
    const fake = makeFake(() => [
      {
        ...PENDING_REVIEW,
        current_salary: null,
        recommended_salary: null,
        employee_first: null,
        employee_last: null,
        requestor_first: 'Solo',
        requestor_last: null,
      },
    ]);
    const svc = new SalaryReviewService(fake.tenantPrisma as never, makePerm() as never);
    const result = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.getById('review-1', ADMIN),
    );
    expect(result.currentSalary).toBeNull();
    expect(result.recommendedSalary).toBeNull();
    expect(result.employeeName).toBeNull();
    expect(result.requestedByName).toBe('Solo'); // single-side name composed
  });
});

describe('SalaryReviewService.create', () => {
  it('refuses caller without personId', async () => {
    const fake = makeFake(() => []);
    const svc = new SalaryReviewService(fake.tenantPrisma as never, makePerm() as never);
    const anon = { ...REQUESTER, personId: '' } as never;
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.create(
          { employeeId: 'emp-1', reviewType: 'ANNUAL_INCREMENT', justification: 'x' },
          anon,
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects invalid reviewType with BadRequest', async () => {
    const fake = makeFake(() => []);
    const svc = new SalaryReviewService(fake.tenantPrisma as never, makePerm() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.create(
          { employeeId: 'emp-1', reviewType: 'BOGUS' as never, justification: 'x' },
          REQUESTER,
        ),
      ),
    ).rejects.toThrow('Invalid reviewType');
  });

  it('rejects negative recommendedSalary', async () => {
    const fake = makeFake(() => []);
    const svc = new SalaryReviewService(fake.tenantPrisma as never, makePerm() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.create(
          {
            employeeId: 'emp-1',
            reviewType: 'ANNUAL_INCREMENT',
            justification: 'x',
            currentSalary: 50000,
            recommendedSalary: -1,
          },
          REQUESTER,
        ),
      ),
    ).rejects.toThrow('recommendedSalary must be >= 0');
  });

  it('rejects employeeId from a different school with a friendly 400', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('SELECT id FROM hr_employees')) return [];
      return [];
    });
    const svc = new SalaryReviewService(fake.tenantPrisma as never, makePerm() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.create(
          {
            employeeId: 'cross-school-employee',
            reviewType: 'ANNUAL_INCREMENT',
            justification: 'x',
          },
          REQUESTER,
        ),
      ),
    ).rejects.toThrow('employeeId does not belong to this school');
  });

  it('happy path: INSERTs the review with status=SUBMITTED + requested_by=actor.personId', async () => {
    let inserted: CapturedCall | undefined;
    const fake = makeFake((call) => {
      if (call.sql.includes('SELECT id FROM hr_employees')) return [{ id: 'emp-1' }];
      if (call.sql.includes('INSERT INTO hr_salary_review_requests')) {
        inserted = call;
        return 0;
      }
      if (call.sql.includes('FROM hr_salary_review_requests')) return [PENDING_REVIEW];
      return [];
    });
    const svc = new SalaryReviewService(fake.tenantPrisma as never, makePerm() as never);
    const result = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.create(
        {
          employeeId: 'emp-1',
          reviewType: 'ANNUAL_INCREMENT',
          currentSalary: 50000,
          recommendedSalary: 55000,
          effectiveDate: '2026-09-01',
          justification: 'Strong performance review',
        },
        REQUESTER,
      ),
    );
    expect(result.id).toBe('review-1');
    expect(inserted).toBeDefined();
    expect(inserted!.sql).toContain("'SUBMITTED'");
    expect(inserted!.args[3]).toBe(REQUESTER.personId); // requested_by
    expect(inserted!.args[4]).toBe('ANNUAL_INCREMENT'); // review_type
    expect(inserted!.args[5]).toBe(50000); // current_salary
    expect(inserted!.args[6]).toBe(55000); // recommended_salary
    expect(inserted!.args[8]).toBe('Strong performance review'); // justification
  });
});

describe('SalaryReviewService.patch — lifecycle invariants', () => {
  function fakeWithReview(row: Record<string, unknown> = PENDING_REVIEW) {
    return makeFake((call) => {
      // The FOR UPDATE lock query
      if (call.sql.includes('FOR UPDATE')) {
        return [{ id: row.id, status: row.status, requested_by: row.requested_by }];
      }
      if (call.sql.includes('FROM hr_salary_review_requests')) return [row];
      return 0;
    });
  }

  it('throws 404 when the row does not exist', async () => {
    const fake = makeFake(() => []);
    const svc = new SalaryReviewService(fake.tenantPrisma as never, makePerm() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.patch('missing', { justification: 'edit' }, ADMIN),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses any edit on an APPROVED review (immutable after decision)', async () => {
    const fake = fakeWithReview({ ...PENDING_REVIEW, status: 'APPROVED' });
    const svc = new SalaryReviewService(fake.tenantPrisma as never, makePerm() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.patch('review-1', { justification: 'edit' }, ADMIN),
      ),
    ).rejects.toThrow('Salary reviews are immutable once decided');
  });

  it('refuses any edit on a REJECTED review (immutable after decision)', async () => {
    const fake = fakeWithReview({ ...PENDING_REVIEW, status: 'REJECTED' });
    const svc = new SalaryReviewService(fake.tenantPrisma as never, makePerm() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.patch('review-1', { decisionNotes: 'too late' }, ADMIN),
      ),
    ).rejects.toThrow('immutable once decided');
  });

  it('rejects invalid status with BadRequest', async () => {
    const fake = fakeWithReview();
    const svc = new SalaryReviewService(fake.tenantPrisma as never, makePerm() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.patch('review-1', { status: 'BOGUS' as never }, ADMIN),
      ),
    ).rejects.toThrow('Invalid status');
  });

  it('non-requester non-admin cannot withdraw', async () => {
    const fake = fakeWithReview({ ...PENDING_REVIEW, requested_by: 'other-person' });
    const svc = new SalaryReviewService(fake.tenantPrisma as never, makePerm() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.patch('review-1', { status: 'WITHDRAWN' }, REQUESTER),
      ),
    ).rejects.toThrow('Only the requester or an admin can withdraw');
  });

  it('requester CAN withdraw own pending review', async () => {
    const fake = fakeWithReview();
    const svc = new SalaryReviewService(fake.tenantPrisma as never, makePerm() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.patch('review-1', { status: 'WITHDRAWN' }, REQUESTER),
      ),
    ).resolves.toBeDefined();
  });

  it('non-admin cannot flip to UNDER_REVIEW / APPROVED / REJECTED', async () => {
    const fake = fakeWithReview();
    const svc = new SalaryReviewService(fake.tenantPrisma as never, makePerm() as never);
    for (const status of ['UNDER_REVIEW', 'APPROVED', 'REJECTED'] as const) {
      await expect(
        runWithTenantContext({ tenant: SCHOOL }, () =>
          svc.patch('review-1', { status }, REQUESTER),
        ),
      ).rejects.toThrow('Only an admin can transition this status');
    }
  });

  it('non-admin non-requester edit (no status field) is refused', async () => {
    const fake = fakeWithReview({ ...PENDING_REVIEW, requested_by: 'other-person' });
    const svc = new SalaryReviewService(fake.tenantPrisma as never, makePerm() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.patch('review-1', { justification: 'edit' }, REQUESTER),
      ),
    ).rejects.toThrow('Only the requester or an admin can edit this review');
  });

  it('admin APPROVED decision stamps decided_by + decided_at = now()', async () => {
    const fake = fakeWithReview();
    const svc = new SalaryReviewService(fake.tenantPrisma as never, makePerm() as never);
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.patch('review-1', { status: 'APPROVED', decisionNotes: 'approved' }, ADMIN),
    );
    const update = fake.capture.find(
      (c) => c.fn === 'e' && c.sql.startsWith('UPDATE hr_salary_review_requests'),
    );
    expect(update).toBeDefined();
    expect(update!.sql).toContain('decided_by =');
    expect(update!.sql).toContain('decided_at = now()');
  });

  it('admin REJECTED decision also stamps decided_by + decided_at', async () => {
    const fake = fakeWithReview();
    const svc = new SalaryReviewService(fake.tenantPrisma as never, makePerm() as never);
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.patch('review-1', { status: 'REJECTED', decisionNotes: 'no budget' }, ADMIN),
    );
    const update = fake.capture.find(
      (c) => c.fn === 'e' && c.sql.startsWith('UPDATE hr_salary_review_requests'),
    );
    expect(update!.sql).toContain('decided_by =');
    expect(update!.sql).toContain('decided_at = now()');
  });

  it('admin flip to UNDER_REVIEW does NOT stamp decided_by/decided_at', async () => {
    const fake = fakeWithReview();
    const svc = new SalaryReviewService(fake.tenantPrisma as never, makePerm() as never);
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.patch('review-1', { status: 'UNDER_REVIEW' }, ADMIN),
    );
    const update = fake.capture.find(
      (c) => c.fn === 'e' && c.sql.startsWith('UPDATE hr_salary_review_requests'),
    );
    expect(update!.sql).not.toContain('decided_at = now()');
  });

  it('requester edit of justification on own pending review is allowed', async () => {
    const fake = fakeWithReview();
    const svc = new SalaryReviewService(fake.tenantPrisma as never, makePerm() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.patch('review-1', { justification: 'updated justification' }, REQUESTER),
      ),
    ).resolves.toBeDefined();
    const update = fake.capture.find(
      (c) => c.fn === 'e' && c.sql.startsWith('UPDATE hr_salary_review_requests'),
    );
    expect(update!.sql).toContain('justification = $1');
  });

  it('no-op patch (no fields) returns current row without firing UPDATE', async () => {
    const fake = fakeWithReview();
    const svc = new SalaryReviewService(fake.tenantPrisma as never, makePerm() as never);
    await runWithTenantContext({ tenant: SCHOOL }, () => svc.patch('review-1', {}, ADMIN));
    const update = fake.capture.find(
      (c) => c.fn === 'e' && c.sql.startsWith('UPDATE hr_salary_review_requests'),
    );
    expect(update).toBeUndefined();
  });

  it('hr-010:write admin can decide approvals', async () => {
    const fake = fakeWithReview();
    const svc = new SalaryReviewService(
      fake.tenantPrisma as never,
      makePerm({ 'hr-010:write': true }) as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.patch('review-1', { status: 'APPROVED' }, REQUESTER),
      ),
    ).resolves.toBeDefined();
  });
});
