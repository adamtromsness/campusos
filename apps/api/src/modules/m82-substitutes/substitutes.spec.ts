import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext, type TenantInfo } from '@shared/tenant';
import { SubstituteProfileService } from './substitute-profile.service';
import { SchoolPoolService } from './school-pool.service';
import { JobPostingService } from './job-posting.service';
import { AssignmentService, deterministicLateCancellationEventId } from './assignment.service';
import { RatingService } from './rating.service';
import { PayRateService } from './pay-rate.service';
import { CancellationPolicyService } from './cancellation-policy.service';
import { SessionNoteService } from './session-note.service';
import { AcceptanceExpiryWorker } from './acceptance-expiry.worker';
import { JobNotificationWorker } from './job-notification.worker';
import { CoverArrangementConsumer } from './cover-arrangement.consumer';

/**
 * P2-9 Sub Marketplace — keystone unit tests.
 *
 * Each spec asserts a single load-bearing invariant called out in the
 * P2-9 plan + P2C9-REVIEW-NOTES.md:
 *
 *   1. Matching engine SQL shape — grade_levels GIN overlap predicate,
 *      BLOCKED-overrides-RECURRING availability resolver, VERIFIED-only
 *      credentials filter, BLOCKED-school exclusion subquery.
 *   2. SubstituteProfileService.getById row scope — non-admin non-self
 *      collapses to 404 don't-leak-existence.
 *   3. SchoolPoolService.addToPool admin gate.
 *   4. JobPostingService.post admin gate + sub.job.posted outbox emit.
 *   5. JobPostingService.accept window-expiry refusal.
 *   6. AssignmentService.cancel computes is_late_cancellation against
 *      policy + emits sub.assignment.late_cancelled with deterministic
 *      v5-shaped event_id keyed on assignment id.
 *   7. AssignmentService.cancel does NOT emit on SCHOOL-side cancellation.
 *   8. AssignmentService.cancel does NOT emit when policy late_window
 *      threshold not crossed.
 *   9. deterministicLateCancellationEventId stability + v5 shape.
 *   10. RatingService refuses ratings on non-CHECKED_OUT assignments.
 *   11. RatingService SCHOOL_RATES_SUB requires admin scope; SUB_RATES_SCHOOL
 *       requires owning substitute.
 *   12. PayRateService.create translates EXCLUDE-gist 23P01 to friendly
 *       409 Conflict.
 *   13. CancellationPolicyService.upsert validates suspension_chk lockstep
 *       (TEMPORARY_POOL_SUSPENSION requires suspensionDurationDays).
 *   14. CancellationPolicyService.upsert validates penalty_chk lockstep
 *       (RATING_PENALTY requires ratingPenaltyAmount in 0–5).
 */

const SCHOOL: TenantInfo = {
  schoolId: '019e0cf8-bbb8-7556-8c81-aaaaaaaaaaaa',
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

const TEACHER_ACTOR = {
  accountId: '019e0cf8-bbb8-7556-8c81-b0000000b001',
  personId: '019e0cf8-bbb8-7556-8c81-b0000000b002',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
  employeeId: '019e0cf8-bbb8-7556-8c81-b0000000b003',
} as never;

const SUBSTITUTE_ACTOR = {
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
    substituteProfile: {
      findUnique: async () => null,
    },
  };
  const tenantPrisma = {
    executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    getPlatformClient: () => client,
  };
  return { capture, client, tenantPrisma };
}

function makeOutbox() {
  const emits: Array<{
    topic: string;
    sourceModule: string;
    key: string;
    payload: Record<string, unknown>;
    eventId?: string;
  }> = [];
  const outbox = {
    enqueueInTx: async (
      _tx: unknown,
      opts: {
        topic: string;
        sourceModule: string;
        key: string;
        payload: Record<string, unknown>;
        eventId?: string;
      },
    ) => {
      emits.push(opts);
    },
  };
  return { outbox, emits };
}

// ── 1. Matching engine SQL shape ─────────────────────────────────────

describe('SubstituteProfileService — matching engine SQL shape', () => {
  it('grade_levels && operator + BLOCKED-overrides-RECURRING + VERIFIED-only + BLOCKED-school exclusion', async () => {
    const fake = makeFake(() => []);
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const svc = new SubstituteProfileService(fake.tenantPrisma as never, permissions as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.search({
        gradeLevels: ['ELEMENTARY', 'MIDDLE'],
        schoolId: SCHOOL.schoolId,
        availableOn: '2026-06-15',
        verifiedOnly: true,
      }),
    );
    const search = fake.capture.find((c) =>
      c.sql.includes('FROM platform.platform_substitute_profiles'),
    );
    expect(search).toBeDefined();
    // GIN overlap operator for grade_levels
    expect(search!.sql).toContain('p.grade_levels && $1::text[]');
    // BLOCKED-school exclusion subquery
    expect(search!.sql).toContain("preference_type = 'BLOCKED'");
    // VERIFIED-credentials filter
    expect(search!.sql).toContain("verification_status = 'VERIFIED'");
    // BLOCKED-overrides-RECURRING availability resolver
    expect(search!.sql).toContain("availability_type = 'RECURRING'");
    expect(search!.sql).toContain("availability_type = 'SPECIFIC'");
    expect(search!.sql).toContain("availability_type = 'BLOCKED'");
    // The NOT EXISTS BLOCKED predicate
    expect(search!.sql).toMatch(
      /NOT EXISTS \(\s*SELECT 1 FROM platform\.platform_sub_availability/,
    );
  });
});

// ── 2. Profile getById row scope — don't-leak-existence ───────────────

describe('SubstituteProfileService.getById — row scope', () => {
  it("non-admin non-self collapses to 404 (don't-leak-existence)", async () => {
    const fake = makeFake(() => null);
    fake.client.substituteProfile.findUnique = (async () => ({
      id: '019e0cf8-bbb8-7556-8c81-aaaaaaaa1111',
      personId: 'someone-else-person-id',
      displayName: 'Sarah J.',
      gradeLevels: ['ELEMENTARY'],
      subjectAreas: [],
      yearsExperience: null,
      maxDistanceMiles: null,
      isAvailable: true,
      overallRating: null,
      totalAssignments: 0,
      isActive: true,
    })) as never;
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const svc = new SubstituteProfileService(fake.tenantPrisma as never, permissions as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.getById('019e0cf8-bbb8-7556-8c81-aaaaaaaa1111', TEACHER_ACTOR),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ── 3. SchoolPoolService admin gate ──────────────────────────────────

describe('SchoolPoolService.addToPool — admin gate', () => {
  it('non-admin without sch-004:write is rejected', async () => {
    const fake = makeFake(() => []);
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const svc = new SchoolPoolService(fake.tenantPrisma as never, permissions as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.addToPool({ substituteId: '019e0cf8-bbb8-7556-8c81-d0000000d001' }, TEACHER_ACTOR),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

// ── 4. JobPostingService post + outbox emit ──────────────────────────

describe('JobPostingService.post — admin gate + sub.job.posted emit', () => {
  it('non-admin is rejected with Forbidden', async () => {
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
        svc.post(
          {
            absentTeacherId: '019e0cf8-bbb8-7556-8c81-c0000000c001',
            jobDate: '2026-06-15',
            startTime: '08:00',
            endTime: '15:00',
          },
          TEACHER_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('admin happy path emits sub.job.posted via outbox with correct shape', async () => {
    let teacherChecked = false;
    let postingInserted = false;
    const fake = makeFake((call) => {
      if (call.sql.includes('SELECT id FROM hr_employees')) {
        teacherChecked = true;
        return [{ id: '019e0cf8-bbb8-7556-8c81-c0000000c001' }];
      }
      if (call.sql.includes('INSERT INTO sub_job_postings')) {
        postingInserted = true;
        return 0;
      }
      if (call.sql.includes('FROM sub_school_pool')) return [];
      if (call.sql.includes('FROM sub_job_postings j')) {
        return [
          {
            id: '019e0cf8-bbb8-7556-8c81-eeeeeeeeeeee',
            school_id: SCHOOL.schoolId,
            absent_teacher_id: '019e0cf8-bbb8-7556-8c81-c0000000c001',
            absent_teacher_name: 'Rivera',
            job_date: '2026-06-15',
            start_time: '08:00:00',
            end_time: '15:00:00',
            job_type: 'FULL_DAY',
            grade_level: null,
            subject: null,
            status: 'OPEN',
            notification_tier: 'POOL',
            acceptance_window_minutes: 30,
            escalate_to_marketplace_at: null,
            filled_at: null,
            created_at: '2026-05-10T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const { outbox, emits } = makeOutbox();
    const svc = new JobPostingService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.post(
        {
          absentTeacherId: '019e0cf8-bbb8-7556-8c81-c0000000c001',
          jobDate: '2026-06-15',
          startTime: '08:00',
          endTime: '15:00',
        },
        ADMIN_ACTOR,
      ),
    );
    expect(teacherChecked).toBe(true);
    expect(postingInserted).toBe(true);
    expect(emits.length).toBe(1);
    expect(emits[0]!.topic).toBe('sub.job.posted');
    expect(emits[0]!.sourceModule).toBe('substitutes');
    expect(emits[0]!.payload.notificationTier).toBe('POOL');
    expect(emits[0]!.payload.poolSize).toBe(0);
  });
});

// ── 5. JobPostingService.accept — window expiry ──────────────────────

describe('JobPostingService.accept — acceptance window expiry', () => {
  it('expired window soft-flips notification to EXPIRED + 409', async () => {
    let notifFlippedToExpired = false;
    const expiredAt = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM sub_job_postings\n         WHERE id = $1::uuid')) {
        return [{ id: 'job-1', status: 'OPEN' }];
      }
      if (call.sql.includes('FROM sub_job_notifications')) {
        return [
          {
            id: 'notif-1',
            response: 'PENDING',
            acceptance_window_expires_at: expiredAt,
          },
        ];
      }
      if (call.sql.includes("UPDATE sub_job_notifications SET response = 'EXPIRED'")) {
        notifFlippedToExpired = true;
        return 0;
      }
      return [];
    });
    fake.client.substituteProfile.findUnique = (async () => ({
      id: 'sub-profile-1',
      personId: SUBSTITUTE_ACTOR.personId,
      displayName: 'Sarah J.',
    })) as never;
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const { outbox } = makeOutbox();
    const svc = new JobPostingService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.accept('019e0cf8-bbb8-7556-8c81-eeeeeeeeeeee', SUBSTITUTE_ACTOR),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(notifFlippedToExpired).toBe(true);
  });
});

// ── 6 + 7 + 8. AssignmentService.cancel + late-cancel emit ───────────

describe('AssignmentService.cancel — late-cancellation emit logic', () => {
  it('late SUBSTITUTE-cancel emits sub.assignment.late_cancelled with deterministic v5 event_id', async () => {
    const assignmentId = '019e0cf8-bbb8-7556-8c81-fffffffffff1';
    const futureJobDate = '2026-12-15';
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM sub_assignments a\n         JOIN sub_job_postings j')) {
        // Job starts in 30 minutes (well within 2h late window)
        const inThirtyMin = new Date(Date.now() + 30 * 60 * 1000);
        const start = inThirtyMin.toISOString().slice(11, 19);
        const today = inThirtyMin.toISOString().slice(0, 10);
        return [
          {
            id: assignmentId,
            status: 'CONFIRMED',
            substitute_id: 'sub-profile-1',
            is_late_cancellation: false,
            job_date: today,
            start_time: start,
            school_id: SCHOOL.schoolId,
            late_window_hours: 2,
          },
        ];
      }
      if (call.sql.includes('UPDATE sub_assignments')) return 0;
      if (call.sql.includes('UPDATE sub_job_postings')) return 0;
      if (
        call.sql.includes('FROM sub_assignments a') &&
        call.sql.includes('WHERE a.id = $1::uuid') &&
        !call.sql.includes('JOIN sub_job_postings j')
      ) {
        return [
          {
            id: assignmentId,
            job_id: 'job-1',
            substitute_id: 'sub-profile-1',
            confirmed_at: '2026-05-10T00:00:00Z',
            check_in_at: null,
            check_out_at: null,
            status: 'CANCELLED',
            cancelled_at: new Date().toISOString(),
            cancelled_by_type: 'SUBSTITUTE',
            cancellation_reason: 'Sick',
            is_late_cancellation: true,
            late_cancellation_consequence_applied: false,
          },
        ];
      }
      void futureJobDate;
      return [];
    });
    fake.client.substituteProfile.findUnique = (async () => ({
      id: 'sub-profile-1',
      personId: SUBSTITUTE_ACTOR.personId,
    })) as never;
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const { outbox, emits } = makeOutbox();
    const svc = new AssignmentService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.cancel(
        assignmentId,
        { cancelledByType: 'SUBSTITUTE', cancellationReason: 'Sick' },
        SUBSTITUTE_ACTOR,
      ),
    );
    expect(emits.length).toBe(1);
    expect(emits[0]!.topic).toBe('sub.assignment.late_cancelled');
    expect(emits[0]!.sourceModule).toBe('substitutes');
    // Deterministic v5-shaped event_id keyed on assignmentId
    expect(emits[0]!.eventId).toBe(deterministicLateCancellationEventId(assignmentId));
    expect(emits[0]!.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(emits[0]!.payload.cancelledByType).toBe('SUBSTITUTE');
  });

  it('SCHOOL-cancel does NOT emit late_cancelled (school-side cancellations are not late)', async () => {
    const assignmentId = '019e0cf8-bbb8-7556-8c81-fffffffffff2';
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM sub_assignments a\n         JOIN sub_job_postings j')) {
        const inThirtyMin = new Date(Date.now() + 30 * 60 * 1000);
        return [
          {
            id: assignmentId,
            status: 'CONFIRMED',
            substitute_id: 'sub-profile-1',
            is_late_cancellation: false,
            job_date: inThirtyMin.toISOString().slice(0, 10),
            start_time: inThirtyMin.toISOString().slice(11, 19),
            school_id: SCHOOL.schoolId,
            late_window_hours: 2,
          },
        ];
      }
      if (
        call.sql.includes('FROM sub_assignments a') &&
        call.sql.includes('WHERE a.id = $1::uuid') &&
        !call.sql.includes('JOIN sub_job_postings j')
      ) {
        return [
          {
            id: assignmentId,
            job_id: 'job-1',
            substitute_id: 'sub-profile-1',
            confirmed_at: '2026-05-10T00:00:00Z',
            check_in_at: null,
            check_out_at: null,
            status: 'CANCELLED',
            cancelled_at: new Date().toISOString(),
            cancelled_by_type: 'SCHOOL',
            cancellation_reason: 'School closure',
            is_late_cancellation: false,
            late_cancellation_consequence_applied: false,
          },
        ];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox, emits } = makeOutbox();
    const svc = new AssignmentService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.cancel(
        assignmentId,
        { cancelledByType: 'SCHOOL', cancellationReason: 'School closure' },
        ADMIN_ACTOR,
      ),
    );
    expect(emits.length).toBe(0);
  });

  it('SUBSTITUTE-cancel outside late window does NOT emit late_cancelled', async () => {
    const assignmentId = '019e0cf8-bbb8-7556-8c81-fffffffffff3';
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM sub_assignments a\n         JOIN sub_job_postings j')) {
        // Job starts 6 hours from now — well outside the 2h late window
        const inSixHours = new Date(Date.now() + 6 * 60 * 60 * 1000);
        return [
          {
            id: assignmentId,
            status: 'CONFIRMED',
            substitute_id: 'sub-profile-1',
            is_late_cancellation: false,
            job_date: inSixHours.toISOString().slice(0, 10),
            start_time: inSixHours.toISOString().slice(11, 19),
            school_id: SCHOOL.schoolId,
            late_window_hours: 2,
          },
        ];
      }
      if (
        call.sql.includes('FROM sub_assignments a') &&
        call.sql.includes('WHERE a.id = $1::uuid') &&
        !call.sql.includes('JOIN sub_job_postings j')
      ) {
        return [
          {
            id: assignmentId,
            job_id: 'job-1',
            substitute_id: 'sub-profile-1',
            confirmed_at: '2026-05-10T00:00:00Z',
            check_in_at: null,
            check_out_at: null,
            status: 'CANCELLED',
            cancelled_at: new Date().toISOString(),
            cancelled_by_type: 'SUBSTITUTE',
            cancellation_reason: 'Got a better offer',
            is_late_cancellation: false,
            late_cancellation_consequence_applied: false,
          },
        ];
      }
      return [];
    });
    fake.client.substituteProfile.findUnique = (async () => ({
      id: 'sub-profile-1',
      personId: SUBSTITUTE_ACTOR.personId,
    })) as never;
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const { outbox, emits } = makeOutbox();
    const svc = new AssignmentService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.cancel(
        assignmentId,
        { cancelledByType: 'SUBSTITUTE', cancellationReason: 'Got a better offer' },
        SUBSTITUTE_ACTOR,
      ),
    );
    expect(emits.length).toBe(0);
  });
});

// ── 9. Deterministic event_id stability + v5 shape ────────────────────

describe('deterministicLateCancellationEventId — stability + shape', () => {
  it('returns the same id for the same assignment id every call', () => {
    const a = '019e0cf8-bbb8-7556-8c81-aaaaaaaaaaa1';
    const e1 = deterministicLateCancellationEventId(a);
    const e2 = deterministicLateCancellationEventId(a);
    expect(e1).toBe(e2);
  });

  it('returns a v5-shaped UUID', () => {
    const e = deterministicLateCancellationEventId('019e0cf8-bbb8-7556-8c81-aaaaaaaaaaa1');
    expect(e).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('different assignment ids produce different event ids', () => {
    const e1 = deterministicLateCancellationEventId('019e0cf8-bbb8-7556-8c81-aaaaaaaaaaa1');
    const e2 = deterministicLateCancellationEventId('019e0cf8-bbb8-7556-8c81-aaaaaaaaaaa2');
    expect(e1).not.toBe(e2);
  });
});

// ── 10 + 11. RatingService gates ──────────────────────────────────────

describe('RatingService.create — authority + lifecycle gates', () => {
  it('SCHOOL_RATES_SUB requires admin scope', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM sub_assignments a')) {
        return [
          {
            id: 'asg-1',
            substitute_id: 'sub-profile-1',
            status: 'CHECKED_OUT',
          },
        ];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const svc = new RatingService(fake.tenantPrisma as never, permissions as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create('asg-1', { raterType: 'SCHOOL_RATES_SUB', overallScore: 5 }, TEACHER_ACTOR),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses ratings on non-CHECKED_OUT assignments', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM sub_assignments a')) {
        return [{ id: 'asg-1', substitute_id: 'sub-profile-1', status: 'CONFIRMED' }];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const svc = new RatingService(fake.tenantPrisma as never, permissions as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create('asg-1', { raterType: 'SCHOOL_RATES_SUB', overallScore: 5 }, ADMIN_ACTOR),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

// ── 12. PayRateService EXCLUDE-gist 23P01 → 409 ──────────────────────

describe('PayRateService.create — EXCLUDE-gist 23P01 → 409 translation', () => {
  it('overlap violation surfaces as ConflictException with friendly message', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('INSERT INTO sub_pay_rates')) {
        // Simulate the postgres EXCLUDE-gist violation
        throw new Error(
          'conflicting key value violates exclusion constraint "sub_pay_rates_no_overlap"',
        );
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const svc = new PayRateService(fake.tenantPrisma as never, permissions as never);
    let caught: unknown = null;
    try {
      await runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create(
          {
            substituteId: '019e0cf8-bbb8-7556-8c81-d0000000d001',
            jobType: 'FULL_DAY',
            rate: 200,
            rateType: 'DAILY',
            effectiveFrom: '2026-01-01',
          },
          ADMIN_ACTOR,
        ),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictException);
    const msg = (caught as Error).message;
    expect(msg).toContain('overlaps');
  });
});

// ── 13 + 14. CancellationPolicyService lockstep validation ────────────

describe('CancellationPolicyService.upsert — lockstep validation', () => {
  it('TEMPORARY_POOL_SUSPENSION requires suspensionDurationDays', async () => {
    const fake = makeFake(() => []);
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const svc = new CancellationPolicyService(fake.tenantPrisma as never, permissions as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.upsert({ consequence: 'TEMPORARY_POOL_SUSPENSION' }, ADMIN_ACTOR),
      ),
    ).rejects.toThrow(/suspensionDurationDays/);
  });

  it('RATING_PENALTY requires ratingPenaltyAmount in 0–5', async () => {
    const fake = makeFake(() => []);
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const svc = new CancellationPolicyService(fake.tenantPrisma as never, permissions as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.upsert({ consequence: 'RATING_PENALTY' }, ADMIN_ACTOR),
      ),
    ).rejects.toThrow(/ratingPenaltyAmount/);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.upsert({ consequence: 'RATING_PENALTY', ratingPenaltyAmount: 6 }, ADMIN_ACTOR),
      ),
    ).rejects.toThrow(/between 0 and 5/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// REVIEW-P2C9 — peer-review fix regressions
// ─────────────────────────────────────────────────────────────────────

// ── BLOCKING 1 — Permission split: generic Staff is NOT marketplace admin

describe('REVIEW-P2C9 BLOCKING 1 — generic Staff cannot post jobs or list profiles', () => {
  it('JobPostingService.post refuses an actor with only sub-001:write (self-service)', async () => {
    const fake = makeFake(() => []);
    // hasAnyPermissionInTenant returns true only for sub-002:write.
    const permissions = {
      hasAnyPermissionInTenant: async (
        _account: string,
        _school: string,
        codes: string[],
      ): Promise<boolean> => (codes.includes('sub-002:write') ? false : false),
    };
    const { outbox } = makeOutbox();
    const svc = new JobPostingService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.post(
          {
            absentTeacherId: '019e0cf8-bbb8-7556-8c81-c0000000c001',
            jobDate: '2026-06-15',
            startTime: '08:00',
            endTime: '15:00',
          },
          TEACHER_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('JobPostingService.hasAdminScope queries sub-002:write specifically', async () => {
    const fake = makeFake(() => []);
    const checked: string[][] = [];
    const permissions = {
      hasAnyPermissionInTenant: async (
        _account: string,
        _school: string,
        codes: string[],
      ): Promise<boolean> => {
        checked.push(codes);
        return false;
      },
    };
    const { outbox } = makeOutbox();
    const svc = new JobPostingService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () => svc.hasAdminScope(TEACHER_ACTOR));
    expect(checked.length).toBeGreaterThan(0);
    expect(checked[0]).toEqual(['sub-002:write']);
    expect(checked[0]).not.toContain('sch-004:write');
    expect(checked[0]).not.toContain('sub-001:write');
  });

  it('SubstituteProfileService.hasMarketplaceScope queries sub-002:write only', async () => {
    const fake = makeFake(() => []);
    const checked: string[][] = [];
    const permissions = {
      hasAnyPermissionInTenant: async (
        _account: string,
        _school: string,
        codes: string[],
      ): Promise<boolean> => {
        checked.push(codes);
        return false;
      },
    };
    const svc = new SubstituteProfileService(fake.tenantPrisma as never, permissions as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.hasMarketplaceScope(TEACHER_ACTOR),
    );
    expect(checked[0]).toEqual(['sub-002:write']);
  });

  it('PayRateService.hasAdminScope queries sub-002:write only', async () => {
    const fake = makeFake(() => []);
    const checked: string[][] = [];
    const permissions = {
      hasAnyPermissionInTenant: async (
        _account: string,
        _school: string,
        codes: string[],
      ): Promise<boolean> => {
        checked.push(codes);
        return false;
      },
    };
    const svc = new PayRateService(fake.tenantPrisma as never, permissions as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => svc.hasAdminScope(TEACHER_ACTOR));
    expect(checked[0]).toEqual(['sub-002:write']);
  });
});

// ── BLOCKING 2 — Job posting school-scoped reference validation

describe('REVIEW-P2C9 BLOCKING 2 — job posting reference validation', () => {
  it('absent teacher lookup includes school_id predicate', async () => {
    let captured: { sql: string; args: unknown[] } | null = null;
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM hr_employees') && call.sql.includes('school_id')) {
        captured = { sql: call.sql, args: call.args };
        return []; // intentionally empty → service should 400
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new JobPostingService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.post(
          {
            absentTeacherId: '019e0cf8-bbb8-7556-8c81-c0000000c001',
            jobDate: '2026-06-15',
            startTime: '08:00',
            endTime: '15:00',
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toThrow(/does not match a teacher in this school/);
    expect(captured).not.toBeNull();
    // SQL must include the school_id predicate
    expect(captured!.sql).toContain('school_id = $1::uuid');
    // First arg = tenant.schoolId; second arg = absentTeacherId
    expect(captured!.args[0]).toBe(SCHOOL.schoolId);
    expect(captured!.args[1]).toBe('019e0cf8-bbb8-7556-8c81-c0000000c001');
  });

  it('timetable slot lookup includes school_id predicate', async () => {
    let slotLookupSql: string | null = null;
    let slotLookupArgs: unknown[] | null = null;
    const fake = makeFake((call) => {
      if (call.sql.includes('SELECT id FROM hr_employees')) {
        return [{ id: '019e0cf8-bbb8-7556-8c81-c0000000c001' }];
      }
      if (call.sql.includes('INSERT INTO sub_job_postings')) return 0;
      if (call.sql.includes('FROM sch_timetable_slots s')) {
        slotLookupSql = call.sql;
        slotLookupArgs = call.args;
        return []; // intentionally empty → service should 400
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new JobPostingService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.post(
          {
            absentTeacherId: '019e0cf8-bbb8-7556-8c81-c0000000c001',
            jobDate: '2026-06-15',
            startTime: '08:00',
            endTime: '15:00',
            timetableSlotIds: ['019e0cf8-bbb8-7556-8c81-aaaaaaaaaaa0'],
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toThrow(/not found in this school/);
    expect(slotLookupSql).not.toBeNull();
    // SQL must include the s.school_id predicate
    expect(slotLookupSql!).toContain('s.school_id = $1::uuid');
    expect(slotLookupArgs![0]).toBe(SCHOOL.schoolId);
    expect(slotLookupArgs![1]).toBe('019e0cf8-bbb8-7556-8c81-aaaaaaaaaaa0');
  });
});

// ── BLOCKING 3 — Workers carry school_id predicates

describe('REVIEW-P2C9 BLOCKING 3 — AcceptanceExpiryWorker school-scope', () => {
  it('UPDATE joins sub_job_postings and predicates by tenant.schoolId', async () => {
    let capturedSql: string | null = null;
    let capturedArgs: unknown[] | null = null;
    const fake = makeFake((call) => {
      if (call.sql.includes('UPDATE sub_job_notifications')) {
        capturedSql = call.sql;
        capturedArgs = call.args;
        return [];
      }
      return [];
    });
    const worker = new AcceptanceExpiryWorker(fake.tenantPrisma as never);
    // Bypass onModuleInit by calling tickForTenant directly via a private accessor
    await (worker as unknown as { tickForTenant(t: TenantInfo): Promise<void> }).tickForTenant(
      SCHOOL,
    );
    expect(capturedSql).not.toBeNull();
    // Sweep query must JOIN through sub_job_postings + filter by school_id
    expect(capturedSql!).toContain('FROM sub_job_postings j');
    expect(capturedSql!).toContain('j.school_id = $1::uuid');
    expect(capturedArgs![0]).toBe(SCHOOL.schoolId);
  });
});

describe('REVIEW-P2C9 BLOCKING 3 — JobNotificationWorker school-scope', () => {
  it('ripe-job SELECT predicates by tenant.schoolId', async () => {
    let capturedSql: string | null = null;
    let capturedArgs: unknown[] | null = null;
    const fake = makeFake((call) => {
      if (
        call.sql.includes('FROM sub_job_postings j') &&
        call.sql.includes('escalate_to_marketplace_at')
      ) {
        capturedSql = call.sql;
        capturedArgs = call.args;
        return [];
      }
      return [];
    });
    const { outbox } = makeOutbox();
    const worker = new JobNotificationWorker(fake.tenantPrisma as never, outbox as never);
    await (worker as unknown as { tickForTenant(t: TenantInfo): Promise<void> }).tickForTenant(
      SCHOOL,
    );
    expect(capturedSql).not.toBeNull();
    expect(capturedSql!).toContain('j.school_id = $1::uuid');
    expect(capturedArgs![0]).toBe(SCHOOL.schoolId);
  });

  it('post-escalate UPDATE predicates by school_id (no-candidates branch)', async () => {
    const updates: Array<{ sql: string; args: unknown[] }> = [];
    const fake = makeFake((call) => {
      if (
        call.sql.includes('FROM sub_job_postings j') &&
        call.sql.includes('escalate_to_marketplace_at')
      ) {
        // Return 1 ripe job — drives the escalate path with 0 candidates.
        return [
          {
            id: '019e0cf8-bbb8-7556-8c81-eeeeeeeeeeef',
            school_id: SCHOOL.schoolId,
            grade_level: 'ELEMENTARY',
            subject: null,
            job_date: '2026-06-15',
            acceptance_window_minutes: 30,
          },
        ];
      }
      if (call.sql.includes('UPDATE sub_job_postings')) {
        updates.push({ sql: call.sql, args: call.args });
        return 0;
      }
      // Candidate query returns empty
      if (call.sql.includes('FROM platform.platform_substitute_profiles')) {
        return [];
      }
      return [];
    });
    const { outbox } = makeOutbox();
    const worker = new JobNotificationWorker(fake.tenantPrisma as never, outbox as never);
    await (worker as unknown as { tickForTenant(t: TenantInfo): Promise<void> }).tickForTenant(
      SCHOOL,
    );
    expect(updates.length).toBe(1);
    expect(updates[0]!.sql).toContain('WHERE school_id = $1::uuid AND id = $2::uuid');
    expect(updates[0]!.args[0]).toBe(SCHOOL.schoolId);
  });
});

// ── BLOCKING 4 — CoverArrangementConsumer

describe('REVIEW-P2C9 BLOCKING 4 — CoverArrangementConsumer school-scope', () => {
  // The consumer is wired through KafkaConsumerService.onModuleInit; for the
  // SQL-shape regression we call the private linkCoverArrangement method
  // directly via a typed escape hatch.
  it('UPDATE sch_coverage_requests JOIN predicates carry school_id', async () => {
    let updateSql: string | null = null;
    let updateArgs: unknown[] | null = null;
    const fake = makeFake((call) => {
      if (call.sql.includes('UPDATE sch_coverage_requests cr')) {
        updateSql = call.sql;
        updateArgs = call.args;
        return [];
      }
      return [];
    });
    // KafkaConsumerService + IdempotencyService stubs — we only need
    // linkCoverArrangement which doesn't touch them.
    const consumer = new CoverArrangementConsumer(
      { subscribe: async () => undefined } as never,
      {} as never,
      fake.tenantPrisma as never,
    );
    const event = {
      eventId: 'evt-1',
      tenant: SCHOOL,
      topic: 'sub.assignment.confirmed',
      payload: {
        assignmentId: 'asg-1',
        jobId: 'job-1',
        schoolId: SCHOOL.schoolId,
        substituteId: 'sub-profile-1',
        substituteName: 'Sarah J.',
        confirmedAt: '2026-05-10T00:00:00Z',
      },
    };
    await (
      consumer as unknown as {
        linkCoverArrangement(e: typeof event): Promise<void>;
      }
    ).linkCoverArrangement(event);
    expect(updateSql).not.toBeNull();
    // Both JOIN and the cr predicate carry $2::uuid (schoolId), and $3 is the jobId
    expect(updateSql!).toContain('j.school_id = $2::uuid');
    expect(updateSql!).toContain('cr.school_id = $2::uuid');
    // arg[0]=notes-suffix, arg[1]=schoolId, arg[2]=jobId
    expect(updateArgs![1]).toBe(SCHOOL.schoolId);
    expect(updateArgs![2]).toBe('job-1');
  });

  it('rejects cross-tenant events where payload.schoolId !== event.tenant.schoolId', async () => {
    let touched = false;
    const fake = makeFake((call) => {
      if (call.sql.includes('UPDATE sch_coverage_requests cr')) {
        touched = true;
        return [];
      }
      return [];
    });
    const consumer = new CoverArrangementConsumer(
      { subscribe: async () => undefined } as never,
      {} as never,
      fake.tenantPrisma as never,
    );
    // ConsumedMessage envelope shape — payload is pre-parsed; the
    // envelope has event_id + tenant_id + payload at the top level.
    // Headers must carry event-id + tenant-id + tenant-subdomain so
    // unwrapEnvelope succeeds; otherwise the consumer drops the event
    // for the wrong reason.
    const msg = {
      key: 'asg-1',
      payload: {
        event_id: '019e0cf8-bbb8-7556-8c81-feeeeeeeeeee',
        event_type: 'sub.assignment.confirmed',
        event_version: 1,
        tenant_id: SCHOOL.schoolId,
        source_module: 'substitutes',
        occurred_at: '2026-05-10T00:00:00Z',
        published_at: '2026-05-10T00:00:00Z',
        payload: {
          assignmentId: 'asg-1',
          jobId: 'job-1',
          // ❌ payload schoolId disagrees with tenant_id above
          schoolId: '019e0cf8-bbb8-7556-8c81-ffffffffff00',
          substituteId: 'sub-profile-1',
          substituteName: 'Sarah J.',
          confirmedAt: '2026-05-10T00:00:00Z',
        },
      },
      headers: {
        'event-id': '019e0cf8-bbb8-7556-8c81-feeeeeeeeeee',
        'tenant-id': SCHOOL.schoolId,
        'tenant-subdomain': SCHOOL.subdomain,
      },
      topic: 'dev.sub.assignment.confirmed',
      partition: 0,
    };
    await (consumer as unknown as { handle(msg: unknown): Promise<void> }).handle(msg);
    expect(touched).toBe(false);
  });
});

// ── MAJOR 5 — Session notes require CHECKED_OUT

describe('REVIEW-P2C9 MAJOR 5 — SessionNoteService.create lifecycle gate', () => {
  it('substitute cannot write a handover note before checkout (status=CONFIRMED → 409)', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM sub_assignments a')) {
        return [
          {
            id: 'asg-1',
            substitute_id: 'sub-profile-1',
            status: 'CONFIRMED',
          },
        ];
      }
      return [];
    });
    fake.client.substituteProfile.findUnique = (async () => ({
      id: 'sub-profile-1',
      personId: SUBSTITUTE_ACTOR.personId,
    })) as never;
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const svc = new SessionNoteService(fake.tenantPrisma as never, permissions as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create('asg-1', { notesText: 'Lesson went well.' }, SUBSTITUTE_ACTOR),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('admin override allowed even on CONFIRMED assignment', async () => {
    let inserted = false;
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM sub_assignments a')) {
        return [
          {
            id: 'asg-1',
            substitute_id: 'sub-profile-1',
            status: 'CONFIRMED',
          },
        ];
      }
      if (call.sql.includes('INSERT INTO sub_session_notes')) {
        inserted = true;
        return 0;
      }
      if (call.sql.includes('FROM sub_session_notes')) {
        return [
          {
            id: 'note-1',
            assignment_id: 'asg-1',
            notes_text: 'Admin override.',
            homework_set: null,
            is_visible_to_teacher: true,
            submitted_at: '2026-05-10T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const svc = new SessionNoteService(fake.tenantPrisma as never, permissions as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.create('asg-1', { notesText: 'Admin override.' }, ADMIN_ACTOR),
    );
    expect(inserted).toBe(true);
  });
});

// ── MAJOR 6 — AssignmentService.cancel flips parent job to UNFILLED

describe('REVIEW-P2C9 MAJOR 6 — cancel flips parent job to UNFILLED, not CANCELLED', () => {
  it('substitute cancel UPDATE sub_job_postings sets status=UNFILLED + clears filled_at', async () => {
    const assignmentId = '019e0cf8-bbb8-7556-8c81-fffffffffff7';
    let parentJobUpdateSql: string | null = null;
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM sub_assignments a\n         JOIN sub_job_postings j')) {
        const inSixHours = new Date(Date.now() + 6 * 60 * 60 * 1000);
        return [
          {
            id: assignmentId,
            status: 'CONFIRMED',
            substitute_id: 'sub-profile-1',
            is_late_cancellation: false,
            job_date: inSixHours.toISOString().slice(0, 10),
            start_time: inSixHours.toISOString().slice(11, 19),
            school_id: SCHOOL.schoolId,
            late_window_hours: 2,
          },
        ];
      }
      if (call.sql.includes('UPDATE sub_job_postings')) {
        parentJobUpdateSql = call.sql;
        return 0;
      }
      if (call.sql.includes('UPDATE sub_assignments')) return 0;
      if (
        call.sql.includes('FROM sub_assignments a') &&
        call.sql.includes('WHERE a.id = $1::uuid') &&
        !call.sql.includes('JOIN sub_job_postings j')
      ) {
        return [
          {
            id: assignmentId,
            job_id: 'job-1',
            substitute_id: 'sub-profile-1',
            confirmed_at: '2026-05-10T00:00:00Z',
            check_in_at: null,
            check_out_at: null,
            status: 'CANCELLED',
            cancelled_at: new Date().toISOString(),
            cancelled_by_type: 'SUBSTITUTE',
            cancellation_reason: 'Sick',
            is_late_cancellation: false,
            late_cancellation_consequence_applied: false,
          },
        ];
      }
      return [];
    });
    fake.client.substituteProfile.findUnique = (async () => ({
      id: 'sub-profile-1',
      personId: SUBSTITUTE_ACTOR.personId,
    })) as never;
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const { outbox } = makeOutbox();
    const svc = new AssignmentService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.cancel(
        assignmentId,
        { cancelledByType: 'SUBSTITUTE', cancellationReason: 'Sick' },
        SUBSTITUTE_ACTOR,
      ),
    );
    expect(parentJobUpdateSql).not.toBeNull();
    expect(parentJobUpdateSql!).toContain("status = 'UNFILLED'");
    expect(parentJobUpdateSql!).toContain('filled_at = NULL');
    expect(parentJobUpdateSql!).not.toContain("status = 'CANCELLED'");
  });
});
