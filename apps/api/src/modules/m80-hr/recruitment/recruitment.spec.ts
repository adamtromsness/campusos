import { describe, it, expect } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '@shared/tenant/tenant.context';
import { PERMISSIONS_KEY } from '@shared/auth/require-permission.decorator';
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
  it('non-admin without hr-011 is rejected with Forbidden', async () => {
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

  // REVIEW-P2-4b BLOCKING #4 — `hr.job.posted` payload must be
  // built from a tx-local reread, not from `this.getById()` which
  // opens a separate tenant context. We assert that the SQL
  // capture shows TWO `SELECT ... FROM hr_job_postings p`
  // queries: one for the FOR UPDATE lock and one for the post-
  // UPDATE reread. The reread must NOT call out to a different
  // client; it stays inside the same tx capture stream.
  it('patch DRAFT -> LIVE rereads the row through tx (not a fresh tenant context) before enqueueing', async () => {
    const postingId = '019e0e69-aaaa-7000-8000-000000000099';
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update')) return [{ id: postingId, status: 'DRAFT' }];
      if (sql.includes('from hr_job_postings p')) {
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
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.patch(postingId, { status: 'LIVE' }, ADMIN_ACTOR),
    );
    // Capture order should be: FOR UPDATE lock (q) -> UPDATE
    // (e) -> SELECT_POSTING_BASE reread (q) -> outbox enqueue.
    // The reread MUST appear AFTER the UPDATE so its result
    // reflects the just-flipped status / posted_at.
    const lockIdx = fake.capture.findIndex(
      (c) => c.fn === 'q' && c.sql.toLowerCase().includes('for update'),
    );
    const updateIdx = fake.capture.findIndex(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('update hr_job_postings set'),
    );
    const rereadIdx = fake.capture.findIndex(
      (c) =>
        c.fn === 'q' &&
        c.sql.toLowerCase().includes('from hr_job_postings p') &&
        !c.sql.toLowerCase().includes('for update'),
    );
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeGreaterThan(lockIdx);
    expect(rereadIdx).toBeGreaterThan(updateIdx);
    // Outbox enqueue carries the posted_at value from the reread.
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.payload.postedAt).toBe('2026-05-09T00:00:00Z');
    expect(enqueued[0]!.payload.positionTitle).toBe('Counselor');
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
      // loadOpenForApply returns posting LIVE — narrow predicate
      // to NOT match the new INSERT … SELECT WHERE p.status='LIVE'
      // path (which also references hr_job_postings p).
      if (
        sql.includes('from hr_job_postings p') &&
        sql.includes("p.status = 'live'") &&
        !sql.includes('insert into hr_applications')
      ) {
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
      // INSERT INTO hr_applications … SELECT … RETURNING throws
      // unique violation (UNIQUE(posting_id, person_id) collision).
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

  // REVIEW-P2-4b BLOCKING #3 — public application insert is now
  // race-safe via INSERT … SELECT WHERE p.status='LIVE' RETURNING.
  // If the posting closes between the upstream loadOpenForApply
  // check and the INSERT, the INSERT writes zero rows and we
  // throw a friendly 400 instead of leaving an orphan application.
  it('apply throws 400 when posting closes between live-check and insert (race)', async () => {
    const postingId = '019e0e69-bbbb-7000-8000-000000000099';
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      // Fast-fail upstream check returns LIVE (so the request
      // gets past the UX guard).
      if (
        sql.includes('from hr_job_postings p') &&
        sql.includes("p.status = 'live'") &&
        !sql.includes('insert into hr_applications')
      ) {
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
      // Existing iam_person — skip identity creation.
      if (sql.includes('from platform.iam_person ip') && sql.includes('lower(pu.email)')) {
        return [{ id: 'person-A' }];
      }
      // The atomic INSERT … SELECT WHERE p.status='LIVE' returns
      // ZERO rows because the posting closed in the race window.
      if (sql.includes('insert into hr_applications') && sql.includes('select')) {
        return [];
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
    ).rejects.toThrow(/no longer accepting applications/);
    // Verify the INSERT was actually attempted with the
    // p.status='LIVE' predicate AND the schoolId argument so a
    // future regression can't silently revert the gate.
    const insert = fake.capture.find(
      (c) =>
        c.fn === 'q' &&
        c.sql.toLowerCase().includes('insert into hr_applications') &&
        c.sql.toLowerCase().includes("p.status = 'live'"),
    );
    expect(insert).toBeTruthy();
    expect(insert!.args).toContain(SCHOOL.schoolId);
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
      // FOR UPDATE on offer — REVIEW-P2-4b BLOCKING #2 follow-up:
      // the lock SELECT now also returns position_title so the
      // ACCEPTED branch can pass it to resolveOrCreatePositionInTx.
      if (sql.includes('from hr_offers o') && sql.includes('for update')) {
        return [
          {
            id: offerId,
            application_id: applicationId,
            status: 'PENDING',
            salary: '50000',
            start_date: startDate,
            contract_type: 'ANNUAL',
            position_title: '5th Grade Teacher',
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
      // REVIEW-P2-4b BLOCKING #2 — existing hr_employees check is
      // now school-scoped (school_id = $1, person_id = $2).
      if (
        sql.includes('select id::text as id from hr_employees') &&
        sql.includes('school_id') &&
        sql.includes('person_id')
      ) {
        return opts.existingEmployee ? [{ id: opts.existingEmployee.id }] : [];
      }
      // REVIEW-P2-4b MAJOR #2 — hr_positions lookup keyed on
      // LOWER(title) = LOWER($2) for the offer's position_title.
      if (sql.includes('from hr_positions') && sql.includes('lower(title)')) {
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

    // REVIEW-P2-4b BLOCKING #2 — the existing-employee lookup
    // SELECT must carry both school_id AND person_id arguments.
    const existingLookup = fake.capture.find(
      (c) =>
        c.fn === 'q' &&
        c.sql.toLowerCase().includes('select id::text as id from hr_employees') &&
        c.sql.toLowerCase().includes('school_id') &&
        c.sql.toLowerCase().includes('person_id'),
    );
    expect(existingLookup).toBeTruthy();
    expect(existingLookup!.args).toContain(SCHOOL.schoolId);
    expect(existingLookup!.args).toContain(CANDIDATE_ACTOR.personId);

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

  // REVIEW-P2-4b BLOCKING #2 — when a candidate accepts an offer
  // at School A and an hr_employees row already exists for the
  // SAME person at School B, the existing-employee lookup must NOT
  // surface the School B row (it's school-scoped). We exercise
  // this by configuring the fake so the school-scoped existing
  // lookup returns []; the un-scoped lookup would have returned
  // the foreign-school row. This proves the production code is
  // querying with school_id in the WHERE clause and not matching
  // a foreign-school row.
  it('cross-school existing employee row is NOT reused — INSERT runs against current school', async () => {
    const offerId = '019e0e69-cccc-7000-8000-000000000099';
    const applicationId = '019e0e69-cccc-7000-8000-000000000098';
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from hr_offers o') && sql.includes('for update')) {
        return [
          {
            id: offerId,
            application_id: applicationId,
            status: 'PENDING',
            salary: '50000',
            start_date: '2026-08-01',
            contract_type: 'ANNUAL',
            position_title: '5th Grade Teacher',
          },
        ];
      }
      if (sql.includes('from hr_applications a') && sql.includes('p.school_id')) {
        return [
          {
            id: applicationId,
            posting_id: 'p-1',
            school_id: SCHOOL.schoolId,
            person_id: CANDIDATE_ACTOR.personId,
            status: 'OFFER_EXTENDED',
          },
        ];
      }
      if (sql.includes('from platform.platform_users') && sql.includes('person_id')) {
        return [{ id: 'acct-1' }];
      }
      if (sql.includes('select employment_type from hr_job_postings')) {
        return [{ employment_type: 'FULL_TIME' }];
      }
      // School-scoped lookup returns [] — no existing employee in
      // CURRENT school. (The foreign-school row exists in the
      // physical table but doesn't match the school_id predicate.)
      if (
        sql.includes('select id::text as id from hr_employees') &&
        sql.includes('school_id') &&
        sql.includes('person_id')
      ) {
        return [];
      }
      // hr_positions lookup — no match, will create
      if (sql.includes('from hr_positions') && sql.includes('lower(title)')) {
        return [];
      }
      if (sql.includes('from hr_offers o')) {
        return [
          {
            id: offerId,
            application_id: applicationId,
            school_id: SCHOOL.schoolId,
            position_title: '5th Grade Teacher',
            salary: '50000',
            start_date: '2026-08-01',
            contract_type: 'ANNUAL',
            conditions: [],
            acceptance_deadline: '2026-05-23',
            status: 'ACCEPTED',
            extended_at: '2026-05-09T00:00:00Z',
            responded_at: '2026-05-09T01:00:00Z',
            response_notes: null,
            created_employee_id: null,
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
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.respond(offerId, { decision: 'ACCEPTED' }, ADMIN_ACTOR),
    );
    // INSERT INTO hr_employees DID fire — a fresh School A row was
    // created instead of reusing the foreign-school row.
    const employeeInsert = fake.capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into hr_employees'),
    );
    expect(employeeInsert).toBeTruthy();
    expect(employeeInsert!.args).toContain(SCHOOL.schoolId);
    // The school-scoped existing lookup ran with both args.
    const existingLookup = fake.capture.find(
      (c) =>
        c.fn === 'q' &&
        c.sql.toLowerCase().includes('select id::text as id from hr_employees') &&
        c.sql.toLowerCase().includes('school_id') &&
        c.sql.toLowerCase().includes('person_id'),
    );
    expect(existingLookup).toBeTruthy();
    expect(existingLookup!.args).toContain(SCHOOL.schoolId);
  });

  // REVIEW-P2-4b MAJOR #2 — the position lookup uses the OFFER's
  // position_title (case-insensitive), not "first active title
  // alphabetically". This test asserts the SQL shape carries
  // LOWER(title) = LOWER($2) and the offer's position_title is
  // bound to $2.
  it('position resolution uses offer.position_title (case-insensitive match), not first-alphabetical', async () => {
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
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.respond(offerId, { decision: 'ACCEPTED' }, CANDIDATE_ACTOR),
    );
    const positionLookup = fake.capture.find(
      (c) =>
        c.fn === 'q' &&
        c.sql.toLowerCase().includes('from hr_positions') &&
        c.sql.toLowerCase().includes('lower(title)'),
    );
    expect(positionLookup).toBeTruthy();
    // The offer's position_title — '5th Grade Teacher' from
    // makeAcceptFake — is the second argument after schoolId.
    expect(positionLookup!.args).toContain('5th Grade Teacher');
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

  // REVIEW-P2-4b BLOCKING #1 — admin recruitment pipeline re-gated
  // from hr-002 to hr-011 so generic Staff (which holds hr-002 from
  // P2-4a's scope) no longer reaches admin candidate / offer / panel
  // endpoints. Candidate-facing offer-respond + per-offer GET keep
  // hr-002:read because the service-layer person-id check is the
  // actual access boundary on those paths.
  it('admin pipeline reads + writes carry hr-011 (not hr-002)', () => {
    expect(gateFor('listPostings')).toEqual(['hr-011:read']);
    expect(gateFor('getPosting')).toEqual(['hr-011:read']);
    expect(gateFor('createPosting')).toEqual(['hr-011:write']);
    expect(gateFor('patchPosting')).toEqual(['hr-011:write']);
    expect(gateFor('listApplications')).toEqual(['hr-011:read']);
    expect(gateFor('getApplication')).toEqual(['hr-011:read']);
    expect(gateFor('listForPosting')).toEqual(['hr-011:read']);
    expect(gateFor('patchApplication')).toEqual(['hr-011:write']);
    expect(gateFor('createPanel')).toEqual(['hr-011:write']);
    expect(gateFor('scheduleInterview')).toEqual(['hr-011:write']);
    expect(gateFor('patchInterview')).toEqual(['hr-011:write']);
    expect(gateFor('extendOffer')).toEqual(['hr-011:write']);
    expect(gateFor('listOffers')).toEqual(['hr-011:read']);
    expect(gateFor('listPanels')).toEqual(['hr-011:read']);
    expect(gateFor('listInterviews')).toEqual(['hr-011:read']);
    expect(gateFor('getInterview')).toEqual(['hr-011:read']);
    expect(gateFor('submitEvaluation')).toEqual(['hr-011:read']);
    expect(gateFor('listEvaluations')).toEqual(['hr-011:read']);
  });

  it('public job-board + apply paths carry no permission gate (handled via @Public())', () => {
    expect(gateFor('listPublicPostings')).toEqual([]);
    expect(gateFor('apply')).toEqual([]);
  });

  it('candidate-facing offer reads + respond keep hr-002:read so candidates reach the surface; service narrows by application.person_id', () => {
    expect(gateFor('getOffer')).toEqual(['hr-002:read']);
    expect(gateFor('respondToOffer')).toEqual(['hr-002:read']);
  });
});
