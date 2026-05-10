import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext, type TenantInfo } from '../tenant/tenant.context';
import { PERMISSIONS_KEY } from '../auth/require-permission.decorator';
import { GameStreamService } from './game-stream.service';
import { GameStreamController } from './game-stream.controller';
import { OfficialService } from './official.service';
import { OfficialController } from './official.controller';
import { RecruitingService } from './recruiting.service';
import { RecruitingController } from './recruiting.controller';

/**
 * P2-8b — Athletics Advanced (Streaming + Officials + Recruiting) keystone unit tests.
 *
 * Each test asserts a single load-bearing invariant:
 *   1. GameStreamService AD-scope gate.
 *   2. GameStreamService.addClipToPortfolio refuses non-CONSENTED clips
 *      (the highlight-clip consent keystone).
 *   3. GameStreamService.addClipToPortfolio refuses already-linked clips.
 *   4. GameStreamService.addClipToPortfolio CONSENTED happy path emits
 *      ath.highlight_clip.portfolio_link_requested.
 *   5. OfficialService.createRating refuses ratings on non-COMPLETED assignments.
 *   6. OfficialService.createRating UNIQUE(assignment, rater_type) catches
 *      duplicate as friendly 400 (the bidirectional rating keystone).
 *   7. OfficialService.transitionAssignment COMPLETED emits
 *      ath.official.assignment.completed.
 *   8. OfficialService.transitionAssignment refuses CANCELLED without reason.
 *   9. RecruitingService refuses non-self non-coach create (STUDENT-OWNED
 *      keystone).
 *   10. RecruitingService.updateProfile refuses students from writing
 *       coachRecommendation.
 *   11. Controller @RequirePermission metadata pins:
 *       - Stream/clip/recording reads/writes to ath-005.
 *       - Official reads/writes to ath-003.
 *       - Recruiting reads/writes to ath-001:read (row-scoped at service layer).
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

const STUDENT_ACTOR = {
  accountId: '019e0cf8-bbb8-7556-8c81-c0000000c001',
  personId: '019e0cf8-bbb8-7556-8c81-c0000000c002',
  personType: 'STUDENT' as const,
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
    getPlatformClient: () => client,
  };
  return { capture, client, tenantPrisma };
}

function makeKafka() {
  const emits: Array<{
    topic: string;
    sourceModule: string;
    key: string;
    payload: Record<string, unknown>;
    eventId?: string;
  }> = [];
  const kafka = {
    emit: async (opts: {
      topic: string;
      sourceModule: string;
      key: string;
      payload: Record<string, unknown>;
    }) => {
      emits.push(opts);
    },
  };
  return { kafka, emits };
}

/**
 * REVIEW-P2-8 BLOCKING 1 + 4 + 5 — outbox mock matching the
 * OutboxService.enqueueInTx signature. Replaces the best-effort
 * kafka.emit in BLOCKING 4 + 5.
 */
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

describe('GameStreamService — AD scope gate', () => {
  it('non-admin without ath-005:write is rejected with Forbidden on configureStream', async () => {
    const fake = makeFake(() => []);
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const { outbox } = makeOutbox();
    const svc = new GameStreamService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.configureStream(
          '019e0cf8-bbb8-7556-8c81-c00000000001',
          { accessLevel: 'PUBLIC' },
          TEACHER_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('GameStreamService.addClipToPortfolio — consent keystone', () => {
  it('refuses non-CONSENTED clips with 400', async () => {
    const clipId = '019e0e69-aaaa-7000-8000-000000000001';
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update of c')) {
        return [
          {
            id: clipId,
            student_id: '019e0e69-aaaa-7000-8000-000000000010',
            consent_status: 'PENDING',
            added_to_portfolio: false,
            s3_key: 's3://x',
            title: 'Drive',
            school_id: SCHOOL.schoolId,
          },
        ];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox, emits } = makeOutbox();
    const svc = new GameStreamService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.addClipToPortfolio(clipId, ADMIN_ACTOR),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(emits.length).toBe(0);
  });

  it('refuses already-linked clips with 400', async () => {
    const clipId = '019e0e69-aaaa-7000-8000-000000000002';
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update of c')) {
        return [
          {
            id: clipId,
            student_id: '019e0e69-aaaa-7000-8000-000000000020',
            consent_status: 'CONSENTED',
            added_to_portfolio: true,
            s3_key: 's3://x',
            title: 'Drive',
            school_id: SCHOOL.schoolId,
          },
        ];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new GameStreamService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.addClipToPortfolio(clipId, ADMIN_ACTOR),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('CONSENTED happy path emits ath.highlight_clip.portfolio_link_requested', async () => {
    const clipId = '019e0e69-aaaa-7000-8000-000000000003';
    const studentId = '019e0e69-aaaa-7000-8000-000000000030';
    let returnAfterUpdate = false;
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update of c')) {
        return [
          {
            id: clipId,
            student_id: studentId,
            consent_status: 'CONSENTED',
            added_to_portfolio: false,
            s3_key: 's3://campusos-clips/test.mp4',
            title: 'Layup',
            school_id: SCHOOL.schoolId,
          },
        ];
      }
      if (sql.includes('update ath_highlight_clips set added_to_portfolio = true')) {
        returnAfterUpdate = true;
      }
      // The post-emit getClipById read
      if (sql.includes('from ath_highlight_clips c') && returnAfterUpdate) {
        return [
          {
            id: clipId,
            stream_id: '019e0e69-aaaa-7000-8000-000000000040',
            student_id: studentId,
            student_name: 'Maya Chen',
            start_time_seconds: 100,
            end_time_seconds: 110,
            title: 'Layup',
            description: null,
            s3_key: 's3://campusos-clips/test.mp4',
            added_to_portfolio: true,
            portfolio_item_id: null,
            consent_status: 'CONSENTED',
            consent_recorded_at: '2026-05-01T00:00:00Z',
            created_by: null,
            created_at: '2026-05-01T00:00:00Z',
            updated_at: '2026-05-01T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox, emits } = makeOutbox();
    const svc = new GameStreamService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.addClipToPortfolio(clipId, ADMIN_ACTOR),
    );
    expect(emits.length).toBe(1);
    expect(emits[0]!.topic).toBe('ath.highlight_clip.portfolio_link_requested');
    expect(emits[0]!.sourceModule).toBe('athletics');
    expect(emits[0]!.payload).toMatchObject({
      clipId,
      studentId,
      schoolId: SCHOOL.schoolId,
      sourceRefId: clipId,
    });
  });
});

describe('OfficialService.createRating — bidirectional + UNIQUE keystone', () => {
  it('refuses ratings on non-COMPLETED assignments with 400', async () => {
    const assignmentId = '019e0e69-aaaa-7000-8000-000000000050';
    // Assignment in CONFIRMED state (not COMPLETED yet)
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from ath_official_assignments') && sql.includes('where id = $1::uuid')) {
        return [
          {
            id: assignmentId,
            game_id: '019e0e69-aaaa-7000-8000-000000000060',
            official_profile_id: '019e0e69-aaaa-7000-8000-000000000070',
            role: 'HEAD_REFEREE',
            fee: '75.00',
            status: 'CONFIRMED',
            payment_status: 'PENDING',
            accepted_at: '2026-05-01T00:00:00Z',
            confirmed_at: '2026-05-02T00:00:00Z',
            completed_at: null,
            cancelled_at: null,
            cancellation_reason: null,
            notes: null,
            assigned_by: null,
            created_at: '2026-05-01T00:00:00Z',
            updated_at: '2026-05-02T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new OfficialService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.createRating(
          assignmentId,
          { raterType: 'SCHOOL_RATES_OFFICIAL', overall: 4 },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('UNIQUE(assignment_id, rater_type) catches duplicate as friendly 400', async () => {
    const assignmentId = '019e0e69-aaaa-7000-8000-000000000051';
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from ath_official_assignments') && sql.includes('where id = $1::uuid')) {
        return [
          {
            id: assignmentId,
            game_id: '019e0e69-aaaa-7000-8000-000000000060',
            official_profile_id: '019e0e69-aaaa-7000-8000-000000000070',
            role: 'HEAD_REFEREE',
            fee: '75.00',
            status: 'COMPLETED',
            payment_status: 'PROCESSED',
            accepted_at: '2026-05-01T00:00:00Z',
            confirmed_at: '2026-05-02T00:00:00Z',
            completed_at: '2026-05-03T00:00:00Z',
            cancelled_at: null,
            cancellation_reason: null,
            notes: null,
            assigned_by: null,
            created_at: '2026-05-01T00:00:00Z',
            updated_at: '2026-05-03T00:00:00Z',
          },
        ];
      }
      if (sql.includes('insert into ath_official_ratings')) {
        const err = new Error('UNIQUE violation');
        Object.assign(err, { code: '23505', meta: { code: '23505' } });
        throw err;
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new OfficialService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.createRating(
          assignmentId,
          { raterType: 'SCHOOL_RATES_OFFICIAL', overall: 4 },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('OfficialService.transitionAssignment — COMPLETED emit + cancellation gate', () => {
  it('COMPLETED transition emits ath.official.assignment.completed', async () => {
    const assignmentId = '019e0e69-aaaa-7000-8000-000000000080';
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update of a')) {
        return [
          {
            id: assignmentId,
            status: 'CONFIRMED',
            official_profile_id: '019e0e69-aaaa-7000-8000-000000000081',
            game_id: '019e0e69-aaaa-7000-8000-000000000082',
            fee: '75.00',
            role: 'HEAD_REFEREE',
            school_id: SCHOOL.schoolId,
          },
        ];
      }
      if (sql.includes('select_assignment') || sql.includes('from ath_official_assignments')) {
        return [
          {
            id: assignmentId,
            game_id: '019e0e69-aaaa-7000-8000-000000000082',
            official_profile_id: '019e0e69-aaaa-7000-8000-000000000081',
            role: 'HEAD_REFEREE',
            fee: '75.00',
            status: 'COMPLETED',
            payment_status: 'PENDING',
            accepted_at: '2026-05-01T00:00:00Z',
            confirmed_at: '2026-05-02T00:00:00Z',
            completed_at: '2026-05-03T00:00:00Z',
            cancelled_at: null,
            cancellation_reason: null,
            notes: null,
            assigned_by: null,
            created_at: '2026-05-01T00:00:00Z',
            updated_at: '2026-05-03T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox, emits } = makeOutbox();
    const svc = new OfficialService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.transitionAssignment(assignmentId, { status: 'COMPLETED' }, ADMIN_ACTOR),
    );
    expect(emits.length).toBe(1);
    expect(emits[0]!.topic).toBe('ath.official.assignment.completed');
    expect(emits[0]!.sourceModule).toBe('athletics');
    expect(emits[0]!.payload).toMatchObject({
      assignmentId,
      schoolId: SCHOOL.schoolId,
      role: 'HEAD_REFEREE',
      fee: 75,
      sourceRefId: assignmentId,
    });
  });

  it('CANCELLED transition without cancellationReason rejected with 400', async () => {
    const assignmentId = '019e0e69-aaaa-7000-8000-000000000090';
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update of a')) {
        return [
          {
            id: assignmentId,
            status: 'POSTED',
            official_profile_id: '019e0e69-aaaa-7000-8000-000000000091',
            game_id: '019e0e69-aaaa-7000-8000-000000000092',
            fee: '50.00',
            role: 'ASSISTANT_REFEREE',
            school_id: SCHOOL.schoolId,
          },
        ];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const svc = new OfficialService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.transitionAssignment(assignmentId, { status: 'CANCELLED' }, ADMIN_ACTOR),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('RecruitingService — student-owned keystone', () => {
  it('non-self non-coach actor cannot create a profile', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select id from sis_students where id =')) {
        return [{ id: '019e0e69-aaaa-7000-8000-000000000100' }];
      }
      // The student-self resolution returns no match because the test actor
      // is not the student.
      if (sql.includes('select s.id from sis_students s join platform.platform_students')) {
        return [];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const svc = new RecruitingService(fake.tenantPrisma as never, permissions as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.createProfile(
          {
            studentId: '019e0e69-aaaa-7000-8000-000000000100',
            sport: 'BASKETBALL',
            graduationYear: 2027,
          },
          STUDENT_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('student cannot write coachRecommendation field', async () => {
    const profileId = '019e0e69-aaaa-7000-8000-000000000110';
    const studentId = '019e0e69-aaaa-7000-8000-000000000111';
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update of rp')) {
        return [
          {
            id: profileId,
            student_id: studentId,
            is_published: false,
            school_id: SCHOOL.schoolId,
          },
        ];
      }
      // student-self resolution succeeds for the student actor on their own profile
      if (sql.includes('from sis_students s join platform.platform_students')) {
        return [{ id: studentId }];
      }
      return [];
    });
    // Student is NOT a coach (no ath-001:write permission)
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const studentSelf = {
      ...STUDENT_ACTOR,
      personId: '019e0e69-aaaa-7000-8000-000000000111-self',
    } as never;
    const svc = new RecruitingService(fake.tenantPrisma as never, permissions as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.updateProfile(profileId, { coachRecommendation: 'I am a great athlete' }, studentSelf),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('REVIEW-P2-8 BLOCKING regression tests', () => {
  it('BLOCKING 4 — portfolio link emit carries deterministic event_id (v5-shaped UUID)', async () => {
    const clipId = '019e0e69-aaaa-7000-8000-000000000003';
    const studentId = '019e0e69-aaaa-7000-8000-000000000030';
    let returnAfterUpdate = false;
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update of c')) {
        return [
          {
            id: clipId,
            student_id: studentId,
            consent_status: 'CONSENTED',
            added_to_portfolio: false,
            s3_key: 's3://test',
            title: 'Test',
            school_id: SCHOOL.schoolId,
          },
        ];
      }
      if (sql.includes('update ath_highlight_clips')) {
        returnAfterUpdate = true;
      }
      if (sql.includes('from ath_highlight_clips c') && returnAfterUpdate) {
        return [
          {
            id: clipId,
            stream_id: '019e0e69-aaaa-7000-8000-000000000040',
            student_id: studentId,
            student_name: null,
            start_time_seconds: 0,
            end_time_seconds: 10,
            title: 'Test',
            description: null,
            s3_key: 's3://test',
            added_to_portfolio: true,
            portfolio_item_id: null,
            consent_status: 'CONSENTED',
            consent_recorded_at: '2026-05-01T00:00:00Z',
            created_by: null,
            created_at: '2026-05-01T00:00:00Z',
            updated_at: '2026-05-01T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox, emits } = makeOutbox();
    const svc = new GameStreamService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.addClipToPortfolio(clipId, ADMIN_ACTOR),
    );
    expect(emits.length).toBe(1);
    expect(emits[0]!.eventId).toBeDefined();
    // v5-shaped UUID: third group starts with '5'
    expect(emits[0]!.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(emits[0]!.sourceModule).toBe('athletics');
  });

  it('BLOCKING 5 — assignment.completed emit carries deterministic event_id', async () => {
    const assignmentId = '019e0e69-aaaa-7000-8000-000000000080';
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update of a')) {
        return [
          {
            id: assignmentId,
            status: 'CONFIRMED',
            official_profile_id: '019e0e69-aaaa-7000-8000-000000000081',
            game_id: '019e0e69-aaaa-7000-8000-000000000082',
            fee: '75.00',
            role: 'HEAD_REFEREE',
            school_id: SCHOOL.schoolId,
          },
        ];
      }
      if (sql.includes('from ath_official_assignments')) {
        return [
          {
            id: assignmentId,
            game_id: '019e0e69-aaaa-7000-8000-000000000082',
            official_profile_id: '019e0e69-aaaa-7000-8000-000000000081',
            role: 'HEAD_REFEREE',
            fee: '75.00',
            status: 'COMPLETED',
            payment_status: 'PENDING',
            accepted_at: '2026-05-01T00:00:00Z',
            confirmed_at: '2026-05-02T00:00:00Z',
            completed_at: '2026-05-03T00:00:00Z',
            cancelled_at: null,
            cancellation_reason: null,
            notes: null,
            assigned_by: null,
            created_at: '2026-05-01T00:00:00Z',
            updated_at: '2026-05-03T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox, emits } = makeOutbox();
    const svc = new OfficialService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.transitionAssignment(assignmentId, { status: 'COMPLETED' }, ADMIN_ACTOR),
    );
    expect(emits.length).toBe(1);
    expect(emits[0]!.eventId).toBeDefined();
    expect(emits[0]!.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('BLOCKING 6 — school AD (tenant ath-003:write only) rejected on platform official profile create', async () => {
    const fake = makeFake(() => []);
    // School Admin holds ath-003:write at SCHOOL scope but NOT at PLATFORM scope.
    const permissions = {
      hasAnyPermissionInTenant: async () => true,
      hasAnyPermission: async () => false,
      resolvePlatformScope: async () => 'platform-scope-id',
    };
    const { outbox } = makeOutbox();
    const svc = new OfficialService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.createProfile(
          {
            personId: '019e0e69-aaaa-7000-8000-000000000200',
            sports: ['BASKETBALL'],
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('BLOCKING 6 — platform admin (PLATFORM-scope auth) can create official profile', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select id::text as id from platform.platform_official_profiles')) {
        return []; // No existing profile for this person
      }
      if (sql.includes('insert into platform.platform_official_profiles')) {
        return 1;
      }
      // getProfileById final read
      if (sql.includes('select op.id::text')) {
        return [
          {
            id: 'p1',
            person_id: '019e0e69-aaaa-7000-8000-000000000200',
            person_name: 'Test Official',
            sports: ['BASKETBALL'],
            certification_level: null,
            certification_body: null,
            certification_expiry: null,
            years_experience: null,
            max_travel_miles: null,
            base_fee: null,
            is_available: true,
            bio: null,
            contact_email: null,
            contact_phone: null,
            average_overall: null,
            rating_count: 0,
            created_at: '2026-05-01T00:00:00Z',
            updated_at: '2026-05-01T00:00:00Z',
          },
        ];
      }
      return [];
    });
    // Platform admin has PLATFORM-scope assignment
    const permissions = {
      hasAnyPermissionInTenant: async () => true,
      hasAnyPermission: async () => true,
      resolvePlatformScope: async () => 'platform-scope-id',
    };
    const { outbox } = makeOutbox();
    const svc = new OfficialService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
    );
    const result = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.createProfile(
        {
          personId: '019e0e69-aaaa-7000-8000-000000000200',
          sports: ['BASKETBALL'],
        },
        ADMIN_ACTOR,
      ),
    );
    expect(result.id).toBe('p1');
  });
});

describe('Controller @RequirePermission metadata — pinned codes', () => {
  it('GameStreamController pins reads to ath-005:read and writes to ath-005:write', () => {
    const live = Reflect.getMetadata(PERMISSIONS_KEY, GameStreamController.prototype.listLive);
    expect(live).toEqual(['ath-005:read']);
    const get = Reflect.getMetadata(PERMISSIONS_KEY, GameStreamController.prototype.getById);
    expect(get).toEqual(['ath-005:read']);
    const config = Reflect.getMetadata(PERMISSIONS_KEY, GameStreamController.prototype.configure);
    expect(config).toEqual(['ath-005:write']);
    const patch = Reflect.getMetadata(PERMISSIONS_KEY, GameStreamController.prototype.patch);
    expect(patch).toEqual(['ath-005:write']);
    const createClip = Reflect.getMetadata(
      PERMISSIONS_KEY,
      GameStreamController.prototype.createClip,
    );
    expect(createClip).toEqual(['ath-005:write']);
    const consent = Reflect.getMetadata(
      PERMISSIONS_KEY,
      GameStreamController.prototype.recordConsent,
    );
    expect(consent).toEqual(['ath-005:read']);
    const portfolio = Reflect.getMetadata(
      PERMISSIONS_KEY,
      GameStreamController.prototype.addToPortfolio,
    );
    expect(portfolio).toEqual(['ath-005:write']);
    const recordings = Reflect.getMetadata(
      PERMISSIONS_KEY,
      GameStreamController.prototype.createRecording,
    );
    expect(recordings).toEqual(['ath-005:write']);
  });

  it('OfficialController pins reads to ath-003:read and writes to ath-003:write', () => {
    const list = Reflect.getMetadata(PERMISSIONS_KEY, OfficialController.prototype.listProfiles);
    expect(list).toEqual(['ath-003:read']);
    const create = Reflect.getMetadata(PERMISSIONS_KEY, OfficialController.prototype.createProfile);
    expect(create).toEqual(['ath-003:write']);
    const update = Reflect.getMetadata(PERMISSIONS_KEY, OfficialController.prototype.updateProfile);
    expect(update).toEqual(['ath-003:write']);
    const avail = Reflect.getMetadata(
      PERMISSIONS_KEY,
      OfficialController.prototype.createAvailability,
    );
    expect(avail).toEqual(['ath-003:write']);
    const assign = Reflect.getMetadata(
      PERMISSIONS_KEY,
      OfficialController.prototype.createAssignment,
    );
    expect(assign).toEqual(['ath-003:write']);
    const transition = Reflect.getMetadata(
      PERMISSIONS_KEY,
      OfficialController.prototype.transitionAssignment,
    );
    expect(transition).toEqual(['ath-003:write']);
    const rate = Reflect.getMetadata(PERMISSIONS_KEY, OfficialController.prototype.createRating);
    expect(rate).toEqual(['ath-003:write']);
  });

  it('RecruitingController pins gates to ath-001:read with row-scope at the service layer', () => {
    const list = Reflect.getMetadata(PERMISSIONS_KEY, RecruitingController.prototype.listProfiles);
    expect(list).toEqual(['ath-001:read']);
    const create = Reflect.getMetadata(
      PERMISSIONS_KEY,
      RecruitingController.prototype.createProfile,
    );
    expect(create).toEqual(['ath-001:read']);
    const patch = Reflect.getMetadata(
      PERMISSIONS_KEY,
      RecruitingController.prototype.updateProfile,
    );
    expect(patch).toEqual(['ath-001:read']);
    const interest = Reflect.getMetadata(
      PERMISSIONS_KEY,
      RecruitingController.prototype.createInterest,
    );
    expect(interest).toEqual(['ath-001:read']);
  });
});
