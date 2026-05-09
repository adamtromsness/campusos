import { describe, it, expect } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '../tenant/tenant.context';
import { PERMISSIONS_KEY } from '../auth/require-permission.decorator';
import { ApplicationService } from './application.service';
import { JobPostingService } from './job-posting.service';
import { OfferService } from './offer.service';
import { RecruitmentController } from './recruitment.controller';

/**
 * P2C4 sub-cycle b — Recruitment keystone unit tests.
 *
 * Each test asserts a single load-bearing invariant:
 *   1. JobPostingService admin gate.
 *   2. JobPostingService.patch LIVE transition enqueues hr.job.posted
 *      via OutboxService.enqueueInTx (durable, not best-effort).
 *   3. JobPostingService.patch refuses transitions out of CLOSED.
 *   4. ApplicationService.apply rejects double-apply (UNIQUE catch).
 *   5. ApplicationService.getById non-admin row scope: owner-only.
 *   6. OfferService.respond ACCEPTED:
 *      - INSERTs hr_employees + hr_employee_positions in same tx.
 *      - Advances application to OFFER_ACCEPTED.
 *      - Enqueues hr.offer.accepted via OutboxService with the full
 *        downstream contract.
 *   7. OfferService.respond ACCEPTED is idempotent — existing
 *      hr_employees row reuses instead of double-inserting.
 *   8. OfferService.respond candidate-only authorisation:
 *      non-admin non-owner gets Forbidden.
 *   9. OfferService.respond refuses non-PENDING offers.
 *  10. Controller permission metadata pins admin reads/writes to
 *      hr-002 and the public board + apply paths to @Public().
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
  accountId: '019e0cf8-bbb8-7556-8c81-000000000001',
  personId: '019e0cf8-bbb8-7556-8c81-000000000002',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
  employeeId: '019e0cf8-bbb8-7556-8c81-000000000099',
} as never;

const CANDIDATE_ACTOR = {
  accountId: '019e0cf8-bbb8-7556-8c81-c0000000c001',
  personId: '019e0cf8-bbb8-7556-8c81-c0000000c002',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
  employeeId: null,
} as never;

const OUTSIDER_ACTOR = {
  accountId: '019e0cf8-bbb8-7556-8c81-d0000000d001',
  personId: '019e0cf8-bbb8-7556-8c81-d0000000d002',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
  employeeId: null,
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

function makeOutbox() {
  const enqueued: Array<{
    topic: string;
    sourceModule: string;
    key: string;
    payload: Record<string, unknown>;
  }> = [];
  const outbox = {
    enqueueInTx: async (_tx: unknown, opts: any) => {
      enqueued.push({
        topic: opts.topic,
        sourceModule: opts.sourceModule,
        key: opts.key,
        payload: opts.payload,
      });
    },
  };
  return { outbox, enqueued };
}

describe('JobPostingService — admin gate + LIVE outbox emit', () => {
  it('non-admin without hr-002:write is rejected with Forbidden', async () => {
    const fake = makeFake(() => []);
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const { outbox } = makeOutbox();
    const svc = new JobPostingService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create(
          {
            positionTitle: 'Counselor',
            description: 'desc',
            employmentType: 'FULL_TIME',
          },
          OUTSIDER_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('patch DRAFT -> LIVE stamps posted_at and enqueues hr.job.posted via outbox', async () => {
    const postingId = '019e0e69-aaaa-7000-8000-000000000001';
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update')) return [{ id: postingId, status: 'DRAFT' }];
      if (sql.includes('from hr_job_postings p')) {
        return [
          {
            id: postingId,
            school_id: SCHOOL.schoolId,
            position_title: 'Counselor',
            department: 'Student Support',
            description: 'desc',
            qualifications_required: null,
            salary_range_low: '40000',
            salary_range_high: '55000',
            employment_type: 'FULL_TIME',
            application_deadline: '2030-01-01',
            status: 'LIVE',
            posted_at: '2026-05-09T00:00:00Z',
            closed_at: null,
            application_count: 0,
            created_at: '2026-05-09T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox, enqueued } = makeOutbox();
    const svc = new JobPostingService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    const dto = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.patch(postingId, { status: 'LIVE' }, ADMIN_ACTOR),
    );
    expect(dto.status).toBe('LIVE');
    // The UPDATE statement must contain posted_at = now() in the SET
    // list — proves the lockstep CHECK is satisfied.
    const updateCall = fake.capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('update hr_job_postings set'),
    );
    expect(updateCall).toBeTruthy();
    expect(updateCall!.sql.toLowerCase()).toContain('posted_at = now()');
    // Outbox enqueue carries the documented payload contract.
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.topic).toBe('hr.job.posted');
    expect(enqueued[0]!.sourceModule).toBe('hr-recruitment');
    expect(enqueued[0]!.key).toBe(postingId);
    const payload = enqueued[0]!.payload;
    expect(payload.postingId).toBe(postingId);
    expect(payload.schoolId).toBe(SCHOOL.schoolId);
    expect(payload.positionTitle).toBe('Counselor');
    expect(payload.employmentType).toBe('FULL_TIME');
    expect(payload.salaryRangeLow).toBe(40000);
    expect(payload.salaryRangeHigh).toBe(55000);
  });

  it('patch refuses to transition out of CLOSED', async () => {
    const fake = makeFake((c) => {
      if (c.sql.toLowerCase().includes('for update')) return [{ id: 'p-1', status: 'CLOSED' }];
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox, enqueued } = makeOutbox();
    const svc = new JobPostingService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.patch('p-1', { status: 'LIVE' }, ADMIN_ACTOR),
      ),
    ).rejects.toThrow(/terminal status CLOSED/);
    expect(enqueued).toHaveLength(0);
  });
});

describe('ApplicationService — apply path + row scope', () => {
  it('apply rejects a duplicate application with friendly 400', async () => {
    const postingId = '019e0e69-bbbb-7000-8000-000000000001';
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      // loadOpenForApply returns posting LIVE
      if (sql.includes('from hr_job_postings p') && sql.includes("p.status = 'live'")) {
        return [
          {
            id: postingId,
            school_id: SCHOOL.schoolId,
            position_title: 'Counselor',
            department: null,
            description: 'desc',
            qualifications_required: null,
            salary_range_low: null,
            salary_range_high: null,
            employment_type: 'FULL_TIME',
            application_deadline: null,
            status: 'LIVE',
            posted_at: '2026-05-01T00:00:00Z',
            closed_at: null,
            application_count: 0,
            created_at: '2026-05-01T00:00:00Z',
          },
        ];
      }
      // iam_person lookup by email — return existing person.
      if (sql.includes('from platform.iam_person ip') && sql.includes('lower(pu.email)')) {
        return [{ id: 'person-A' }];
      }
      // INSERT INTO hr_applications throws unique violation.
      if (sql.includes('insert into hr_applications')) {
        const err = new Error('unique_violation') as any;
        err.code = 'P2010';
        err.meta = { code: '23505' };
        throw err;
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const postings = new JobPostingService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    const svc = new ApplicationService(fake.tenantPrisma as never, permissions as never, postings);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.apply(postingId, {
          applicantEmail: 'cand@example.com',
          firstName: 'Cand',
          lastName: 'Idate',
        }),
      ),
    ).rejects.toThrow(/already applied/);
  });

  it('non-admin getById on someone else returns collapsed 404', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from hr_applications a')) {
        return [
          {
            id: 'app-A',
            posting_id: 'p-1',
            posting_title: 'Counselor',
            person_id: 'someone-else',
            applicant_first: 'Other',
            applicant_last: 'Person',
            applicant_email: 'other@example.com',
            status: 'SUBMITTED',
            resume_s3_key: null,
            cover_letter_s3_key: null,
            submitted_at: '2026-05-01T00:00:00Z',
            not_selected_reason: null,
            withdrawn_reason: null,
          },
        ];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const { outbox } = makeOutbox();
    const postings = new JobPostingService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    const svc = new ApplicationService(fake.tenantPrisma as never, permissions as never, postings);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () => svc.getById('app-A', CANDIDATE_ACTOR)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('OfferService.respond — ACCEPTED auto-hires + outbox', () => {
  function makeAcceptFake(opts: {
    existingEmployee?: { id: string };
    candidatePersonId: string;
    skipPositionStub?: boolean;
  }) {
    const offerId = '019e0e69-cccc-7000-8000-000000000001';
    const applicationId = '019e0e69-cccc-7000-8000-000000000010';
    const postingId = '019e0e69-cccc-7000-8000-000000000020';
    const accountId = '019e0e69-cccc-7000-8000-000000000030';
    const startDate = '2026-08-01';
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      // FOR UPDATE on offer
      if (sql.includes('from hr_offers o') && sql.includes('for update')) {
        return [
          {
            id: offerId,
            application_id: applicationId,
            status: 'PENDING',
            salary: '50000',
            start_date: startDate,
            contract_type: 'ANNUAL',
          },
        ];
      }
      // ApplicationService.loadInternal
      if (sql.includes('from hr_applications a') && sql.includes('p.school_id')) {
        return [
          {
            id: applicationId,
            posting_id: postingId,
            school_id: SCHOOL.schoolId,
            person_id: opts.candidatePersonId,
            status: 'OFFER_EXTENDED',
          },
        ];
      }
      // platform_users lookup by person_id
      if (sql.includes('from platform.platform_users') && sql.includes('person_id')) {
        return [{ id: accountId }];
      }
      // posting employment_type lookup
      if (sql.includes('select employment_type from hr_job_postings')) {
        return [{ employment_type: 'FULL_TIME' }];
      }
      // existing hr_employees check
      if (sql.includes('select id::text as id from hr_employees where person_id')) {
        return opts.existingEmployee ? [{ id: opts.existingEmployee.id }] : [];
      }
      // hr_positions lookup for resolveOrCreatePositionInTx
      if (sql.includes('from hr_positions where school_id')) {
        return opts.skipPositionStub ? [{ id: 'pos-existing' }] : [];
      }
      // Final reload via SELECT_OFFER_BASE
      if (sql.includes('from hr_offers o')) {
        return [
          {
            id: offerId,
            application_id: applicationId,
            school_id: SCHOOL.schoolId,
            position_title: '5th Grade Teacher',
            salary: '50000',
            start_date: startDate,
            contract_type: 'ANNUAL',
            conditions: [],
            acceptance_deadline: '2026-05-23',
            status: 'ACCEPTED',
            extended_at: '2026-05-09T00:00:00Z',
            responded_at: '2026-05-09T01:00:00Z',
            response_notes: 'Accepted, looking forward to it.',
            created_employee_id: null,
          },
        ];
      }
      return [];
    });
    return { fake, offerId, applicationId, accountId };
  }

  it('candidate ACCEPT inserts hr_employees + hr_employee_positions + advances application + enqueues hr.offer.accepted', async () => {
    const { fake, offerId, applicationId, accountId } = makeAcceptFake({
      candidatePersonId: CANDIDATE_ACTOR.personId,
    });
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const { outbox, enqueued } = makeOutbox();
    const postings = new JobPostingService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    const applications = new ApplicationService(
      fake.tenantPrisma as never,
      permissions as never,
      postings,
    );
    const svc = new OfferService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
      applications,
    );
    const dto = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.respond(
        offerId,
        { decision: 'ACCEPTED', responseNotes: 'Accepted, looking forward to it.' },
        CANDIDATE_ACTOR,
      ),
    );
    expect(dto.status).toBe('ACCEPTED');

    // hr_employees INSERT happened (no existing row this time).
    const employeeInsert = fake.capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into hr_employees'),
    );
    expect(employeeInsert).toBeTruthy();
    expect(employeeInsert!.args).toContain(SCHOOL.schoolId);
    expect(employeeInsert!.args).toContain(CANDIDATE_ACTOR.personId);
    expect(employeeInsert!.args).toContain(accountId);

    // hr_employee_positions INSERT happened.
    const positionInsert = fake.capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into hr_employee_positions'),
    );
    expect(positionInsert).toBeTruthy();

    // Application advanced to OFFER_ACCEPTED.
    const advance = fake.capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes('update hr_applications set status') &&
        c.args.includes('OFFER_ACCEPTED'),
    );
    expect(advance).toBeTruthy();

    // Outbox enqueue carries the contract.
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.topic).toBe('hr.offer.accepted');
    expect(enqueued[0]!.sourceModule).toBe('hr-recruitment');
    expect(enqueued[0]!.key).toBe(offerId);
    const payload = enqueued[0]!.payload;
    expect(payload.offerId).toBe(offerId);
    expect(payload.applicationId).toBe(applicationId);
    expect(payload.schoolId).toBe(SCHOOL.schoolId);
    expect(payload.personId).toBe(CANDIDATE_ACTOR.personId);
    expect(payload.salary).toBe(50000);
    expect(payload.contractType).toBe('ANNUAL');
    expect(typeof payload.acceptedAt).toBe('string');
  });

  it('ACCEPT is idempotent — existing hr_employees row is reused, no duplicate insert', async () => {
    const { fake, offerId } = makeAcceptFake({
      candidatePersonId: CANDIDATE_ACTOR.personId,
      existingEmployee: { id: 'emp-existing' },
    });
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const { outbox } = makeOutbox();
    const postings = new JobPostingService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    const applications = new ApplicationService(
      fake.tenantPrisma as never,
      permissions as never,
      postings,
    );
    const svc = new OfferService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
      applications,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.respond(offerId, { decision: 'ACCEPTED' }, CANDIDATE_ACTOR),
    );
    // INSERT INTO hr_employees should NOT have fired — re-hire path
    // reuses + flips employment_status only.
    const employeeInsert = fake.capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into hr_employees'),
    );
    expect(employeeInsert).toBeUndefined();
    // Re-activation UPDATE on TERMINATED records should appear.
    const reactivate = fake.capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes("update hr_employees set employment_status = 'active'"),
    );
    expect(reactivate).toBeTruthy();
  });

  it('non-admin non-owner cannot respond — Forbidden', async () => {
    const { fake, offerId } = makeAcceptFake({
      candidatePersonId: CANDIDATE_ACTOR.personId,
    });
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const { outbox } = makeOutbox();
    const postings = new JobPostingService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    const applications = new ApplicationService(
      fake.tenantPrisma as never,
      permissions as never,
      postings,
    );
    const svc = new OfferService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
      applications,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.respond(offerId, { decision: 'ACCEPTED' }, OUTSIDER_ACTOR),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('respond refuses non-PENDING offers', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from hr_offers o') && sql.includes('for update')) {
        return [
          {
            id: 'o-1',
            application_id: 'a-1',
            status: 'ACCEPTED',
            salary: '50000',
            start_date: '2026-08-01',
            contract_type: 'ANNUAL',
          },
        ];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const postings = new JobPostingService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    const applications = new ApplicationService(
      fake.tenantPrisma as never,
      permissions as never,
      postings,
    );
    const svc = new OfferService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
      applications,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.respond('o-1', { decision: 'ACCEPTED' }, ADMIN_ACTOR),
      ),
    ).rejects.toThrow(/Only PENDING offers/);
  });
});

describe('RecruitmentController — permission gate distribution', () => {
  const proto = RecruitmentController.prototype as unknown as Record<string, () => unknown>;

  function gateFor(methodName: string): string[] {
    return Reflect.getMetadata(PERMISSIONS_KEY, proto[methodName]!) ?? [];
  }

  it('admin reads + writes carry hr-002', () => {
    expect(gateFor('listPostings')).toEqual(['hr-002:read']);
    expect(gateFor('getPosting')).toEqual(['hr-002:read']);
    expect(gateFor('createPosting')).toEqual(['hr-002:write']);
    expect(gateFor('patchPosting')).toEqual(['hr-002:write']);
    expect(gateFor('listApplications')).toEqual(['hr-002:read']);
    expect(gateFor('getApplication')).toEqual(['hr-002:read']);
    expect(gateFor('listForPosting')).toEqual(['hr-002:read']);
    expect(gateFor('patchApplication')).toEqual(['hr-002:write']);
    expect(gateFor('createPanel')).toEqual(['hr-002:write']);
    expect(gateFor('scheduleInterview')).toEqual(['hr-002:write']);
    expect(gateFor('patchInterview')).toEqual(['hr-002:write']);
    expect(gateFor('extendOffer')).toEqual(['hr-002:write']);
  });

  it('public job-board + apply paths carry no hr-002 gate (handled via @Public())', () => {
    expect(gateFor('listPublicPostings')).toEqual([]);
    expect(gateFor('apply')).toEqual([]);
  });

  it('respondToOffer keeps hr-002:read so candidates can reach it; service narrows by application.person_id', () => {
    expect(gateFor('respondToOffer')).toEqual(['hr-002:read']);
  });
});
