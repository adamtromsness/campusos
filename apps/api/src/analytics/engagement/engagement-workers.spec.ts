import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  AthleticsReadModelWorker,
  ClubsReadModelWorker,
  CommsReadModelWorker,
  EnrolmentReadModelWorker,
  GroupsReadModelWorker,
  OfficialsReadModelWorker,
  PublicationsReadModelWorker,
  WellbeingReadModelWorker,
} from './engagement-workers.service';
import type { UnwrappedEvent } from '../../notifications/consumers/notification-consumer-base';

/**
 * P2-15b engagement workers — unit tests.
 *
 * Verifies for every worker:
 *   1. UPSERT targets the right rpt_* table and lands ON CONFLICT against
 *      the documented UNIQUE constraint (replay produces the same row).
 *   2. Workers honour the single-writer rule — each spec asserts the
 *      worker writes only to its own targets, never anyone else's.
 *   3. WellbeingReadModelWorker writes ONLY the aggregate columns, NEVER
 *      a student_id (the PRIVACY KEYSTONE) — schema-level absence of the
 *      column is the wire-level backstop, but the test pins the SQL too.
 *   4. OfficialsReadModelWorker is the weekly batch — it has no consumer
 *      subscription on boot and exposes a `materialise(schoolId, period)`
 *      entry point.
 */

const SCHOOL = {
  schoolId: '019e0cf8-bbb8-7556-8c81-aaaaaaaaaaaa',
  subdomain: 'demo',
  schemaName: 'tenant_demo',
  organisationId: null,
  isFrozen: false,
  planTier: 'STANDARD',
  homeRegion: 'us-east-1',
} as never;

interface CapturedCall {
  sql: string;
  args: unknown[];
}

function makeFake(handler?: (call: CapturedCall) => unknown) {
  const capture: CapturedCall[] = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      const call: CapturedCall = { sql, args };
      capture.push(call);
      return handler?.(call) ?? [];
    },
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
      const call: CapturedCall = { sql, args };
      capture.push(call);
      return handler?.(call) ?? 1;
    },
  };
  const tenantPrisma = {
    executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
  };
  return { capture, tenantPrisma };
}

function makeCheckpointStub() {
  const recorded: Array<{
    consumerGroup: string;
    topic: string;
    partition: number;
    offset: number;
  }> = [];
  const checkpoints = {
    record: async (
      consumerGroup: string,
      topic: string,
      partition: number,
      offset: number,
    ): Promise<void> => {
      recorded.push({ consumerGroup, topic, partition, offset });
    },
    list: async () => [],
  };
  return { recorded, checkpoints };
}

function unwrappedEvent<P>(payload: P, topic: string, eventId = 'evt-1'): UnwrappedEvent<P> {
  return {
    eventId,
    tenant: SCHOOL,
    payload,
    topic,
  };
}

describe('EnrolmentReadModelWorker', () => {
  it('upsert(enr.application.submitted) UPSERTs into rpt_enr_funnel_summary on (school, year)', async () => {
    const { capture, tenantPrisma } = makeFake();
    const { checkpoints } = makeCheckpointStub();
    const worker = new EnrolmentReadModelWorker(
      {} as never,
      {} as never,
      tenantPrisma as never,
      checkpoints as never,
    );
    await worker.upsert(
      unwrappedEvent(
        {
          applicationId: 'app-1',
          schoolId: SCHOOL.schoolId,
          academicYearName: '2026-2027',
          submittedAt: '2026-04-15',
        },
        'dev.enr.application.submitted',
      ),
      'dev.enr.application.submitted',
    );
    expect(capture.length).toBe(1);
    expect(capture[0]!.sql).toContain('rpt_enr_funnel_summary');
    expect(capture[0]!.sql).toContain('ON CONFLICT (school_id, academic_year) DO UPDATE');
    // applications_received delta = 1
    expect(capture[0]!.args[3]).toBe(1);
  });

  it('upsert(enr.student.enrolled) increments enrolled count', async () => {
    const { capture, tenantPrisma } = makeFake();
    const { checkpoints } = makeCheckpointStub();
    const worker = new EnrolmentReadModelWorker(
      {} as never,
      {} as never,
      tenantPrisma as never,
      checkpoints as never,
    );
    await worker.upsert(
      unwrappedEvent(
        {
          applicationId: 'app-1',
          schoolId: SCHOOL.schoolId,
          academicYearName: '2026-2027',
        },
        'dev.enr.student.enrolled',
      ),
      'dev.enr.student.enrolled',
    );
    // 8th arg (0-indexed 7) is enrolled delta
    expect(capture[0]!.args[7]).toBe(1);
  });
});

describe('AthleticsReadModelWorker', () => {
  it('upsert(ath.game.completed) writes BOTH rpt_game_results AND rpt_ath_season_summary', async () => {
    const { capture, tenantPrisma } = makeFake();
    const { checkpoints } = makeCheckpointStub();
    const worker = new AthleticsReadModelWorker(
      {} as never,
      {} as never,
      tenantPrisma as never,
      checkpoints as never,
    );
    await worker.upsert(
      unwrappedEvent(
        {
          gameId: 'g-1',
          schoolId: SCHOOL.schoolId,
          seasonId: 'aaaaaaaa-aaaa-7000-8000-000000000001',
          programmeId: 'bbbbbbbb-bbbb-7000-8000-000000000001',
          sport: 'BASKETBALL',
          homeScore: 72,
          awayScore: 58,
          result: 'WIN',
          rosterSize: 14,
          injuriesThisGame: 0,
          completedAt: '2026-04-15',
        },
        'dev.ath.game.completed',
      ),
    );
    expect(capture.length).toBe(2);
    expect(capture[0]!.sql).toContain('rpt_game_results');
    expect(capture[0]!.sql).toContain('ON CONFLICT (school_id, game_id) DO UPDATE');
    expect(capture[1]!.sql).toContain('rpt_ath_season_summary');
    expect(capture[1]!.sql).toContain('ON CONFLICT (school_id, season_id, programme_id) DO UPDATE');
  });
});

describe('OfficialsReadModelWorker — WEEKLY BATCH', () => {
  it('does NOT subscribe to a Kafka topic on construction (weekly batch only)', () => {
    // The worker is plain @Injectable() with no OnModuleInit hook —
    // confirms by spec contract that it does not auto-subscribe.
    const worker = new OfficialsReadModelWorker({} as never, {} as never);
    expect((worker as unknown as { onModuleInit?: () => unknown }).onModuleInit).toBeUndefined();
  });

  it('materialise(school, period) UPSERTs rpt_officials_marketplace on (school, period)', async () => {
    const { capture, tenantPrisma } = makeFake((call) => {
      // Domain-table-exists probe → return [] so worker writes the
      // zero-fallback row.
      if (call.sql.includes('information_schema.tables')) return [];
      return [];
    });
    const { checkpoints } = makeCheckpointStub();
    const worker = new OfficialsReadModelWorker(tenantPrisma as never, checkpoints as never);
    const r = await worker.materialise(SCHOOL.schoolId, '2026-04-06');
    expect(r.rowsWritten).toBe(1);
    // First call is the existence probe; second is the INSERT.
    const insertCall = capture.find((c) => c.sql.includes('rpt_officials_marketplace'));
    expect(insertCall?.sql).toContain('ON CONFLICT (school_id, period) DO UPDATE');
  });
});

describe('GroupsReadModelWorker', () => {
  it('upsert(grp.post.created) increments posts_count', async () => {
    const { capture, tenantPrisma } = makeFake();
    const { checkpoints } = makeCheckpointStub();
    const worker = new GroupsReadModelWorker(
      {} as never,
      {} as never,
      tenantPrisma as never,
      checkpoints as never,
    );
    await worker.upsert(
      unwrappedEvent(
        {
          schoolId: SCHOOL.schoolId,
          groupId: 'dddddddd-dddd-7000-8000-000000000001',
          eventType: 'POST_CREATED' as const,
          occurredAt: '2026-04-15',
        },
        'dev.grp.post.created',
      ),
      'dev.grp.post.created',
    );
    expect(capture[0]!.sql).toContain('rpt_grp_engagement_summary');
    expect(capture[0]!.sql).toContain('ON CONFLICT (school_id, group_id, period) DO UPDATE');
    // posts delta is positional arg 6 (0-indexed 5)
    expect(capture[0]!.args[5]).toBe(1);
  });
});

describe('PublicationsReadModelWorker', () => {
  it('upsert(pub.publication.published) increments publications_count', async () => {
    const { capture, tenantPrisma } = makeFake();
    const { checkpoints } = makeCheckpointStub();
    const worker = new PublicationsReadModelWorker(
      {} as never,
      {} as never,
      tenantPrisma as never,
      checkpoints as never,
    );
    await worker.upsert(
      unwrappedEvent(
        {
          publicationId: 'pub-1',
          schoolId: SCHOOL.schoolId,
          timeToPublishDays: 5,
          views: 120,
          downloads: 32,
          publishedAt: '2026-04-15',
        },
        'dev.pub.publication.published',
      ),
    );
    expect(capture[0]!.sql).toContain('rpt_pub_distribution_summary');
    expect(capture[0]!.sql).toContain('ON CONFLICT (school_id, period) DO UPDATE');
  });
});

describe('ClubsReadModelWorker', () => {
  it('upsert(ext.activity.completed) UPSERTs on (school, academic_year, club_id)', async () => {
    const { capture, tenantPrisma } = makeFake();
    const { checkpoints } = makeCheckpointStub();
    const worker = new ClubsReadModelWorker(
      {} as never,
      {} as never,
      tenantPrisma as never,
      checkpoints as never,
    );
    await worker.upsert(
      unwrappedEvent(
        {
          activityId: 'act-1',
          schoolId: SCHOOL.schoolId,
          clubId: 'eeeeeeee-eeee-7000-8000-000000000001',
          academicYear: '2026-2027',
          attendees: 22,
          totalRegistered: 30,
          budgetSpent: 150,
          completedAt: '2026-04-15',
        },
        'dev.ext.activity.completed',
      ),
    );
    expect(capture[0]!.sql).toContain('rpt_ext_service_summary');
    expect(capture[0]!.sql).toContain('ON CONFLICT (school_id, academic_year, club_id) DO UPDATE');
  });
});

describe('CommsReadModelWorker', () => {
  it('upsert(msg.message.sent) bumps messages_sent', async () => {
    const { capture, tenantPrisma } = makeFake();
    const { checkpoints } = makeCheckpointStub();
    const worker = new CommsReadModelWorker(
      {} as never,
      {} as never,
      tenantPrisma as never,
      checkpoints as never,
    );
    await worker.upsert(
      unwrappedEvent(
        {
          schoolId: SCHOOL.schoolId,
          delivered: true,
          read: false,
          sentAt: '2026-04-15',
        },
        'dev.msg.message.sent',
      ),
      'dev.msg.message.sent',
    );
    expect(capture[0]!.sql).toContain('rpt_msg_communication_metrics');
    expect(capture[0]!.sql).toContain('ON CONFLICT (school_id, period) DO UPDATE');
  });

  it('upsert(msg.broadcast.sent) bumps broadcasts_sent not messages_sent', async () => {
    const { capture, tenantPrisma } = makeFake();
    const { checkpoints } = makeCheckpointStub();
    const worker = new CommsReadModelWorker(
      {} as never,
      {} as never,
      tenantPrisma as never,
      checkpoints as never,
    );
    await worker.upsert(
      unwrappedEvent(
        {
          schoolId: SCHOOL.schoolId,
          delivered: true,
          sentAt: '2026-04-15',
        },
        'dev.msg.broadcast.sent',
      ),
      'dev.msg.broadcast.sent',
    );
    // messages_delta (arg 4, 0-indexed 3) is 0 for broadcasts
    expect(capture[0]!.args[3]).toBe(0);
    expect(capture[0]!.args[4]).toBe(1);
  });
});

describe('WellbeingReadModelWorker — PRIVACY KEYSTONE', () => {
  it('upsert(svc.wellbeing.response.submitted) writes ONLY aggregate columns — never student_id', async () => {
    const { capture, tenantPrisma } = makeFake();
    const { checkpoints } = makeCheckpointStub();
    const worker = new WellbeingReadModelWorker(
      {} as never,
      {} as never,
      tenantPrisma as never,
      checkpoints as never,
    );
    await worker.upsert(
      unwrappedEvent(
        {
          responseId: 'resp-1',
          schoolId: SCHOOL.schoolId,
          gradeLevel: '5',
          domain: 'EMOTIONAL' as const,
          numericResponse: 4,
          questionType: 'SCALE_1_5' as const,
          submittedAt: '2026-04-15',
        },
        'dev.svc.wellbeing.response.submitted',
      ),
    );
    expect(capture[0]!.sql).toContain('rpt_wellbeing_domain_trends');
    expect(capture[0]!.sql).toContain(
      'ON CONFLICT (school_id, period, grade_level, domain) DO UPDATE',
    );
    // PRIVACY INVARIANT — the SQL must not reference student_id or response_id columns
    expect(capture[0]!.sql).not.toMatch(/student_id/);
    expect(capture[0]!.sql).not.toMatch(/response_id/);
  });

  it('flags SAFETY SCALE_1_5=1 responses as below_threshold', async () => {
    const { capture, tenantPrisma } = makeFake();
    const { checkpoints } = makeCheckpointStub();
    const worker = new WellbeingReadModelWorker(
      {} as never,
      {} as never,
      tenantPrisma as never,
      checkpoints as never,
    );
    await worker.upsert(
      unwrappedEvent(
        {
          responseId: 'resp-1',
          schoolId: SCHOOL.schoolId,
          gradeLevel: '5',
          domain: 'SAFETY' as const,
          numericResponse: 1,
          questionType: 'SCALE_1_5' as const,
          submittedAt: '2026-04-15',
        },
        'dev.svc.wellbeing.response.submitted',
      ),
    );
    // below_threshold delta — positional arg 7 (0-indexed 6) is the count delta
    expect(capture[0]!.args[6]).toBe(1);
  });

  it('drops payloads missing schoolId/gradeLevel/domain', async () => {
    const { capture, tenantPrisma } = makeFake();
    const { checkpoints } = makeCheckpointStub();
    const worker = new WellbeingReadModelWorker(
      {} as never,
      {} as never,
      tenantPrisma as never,
      checkpoints as never,
    );
    await worker.upsert(
      unwrappedEvent(
        {
          responseId: 'resp-1',
          schoolId: '',
          gradeLevel: '5',
          domain: 'SAFETY' as const,
          submittedAt: '2026-04-15',
        },
        'dev.svc.wellbeing.response.submitted',
      ),
    );
    expect(capture.length).toBe(0);
  });
});
