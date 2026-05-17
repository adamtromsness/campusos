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
import type { UnwrappedEvent } from '@modules/m40-communications/notifications/consumers/notification-consumer-base';

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
  // capture only the rpt_* read-model UPSERTs the assertions exercise.
  // rpt_event_contributions claim INSERTs (REVIEW-P2C15 R1 BLOCKING 1) are
  // infrastructure and are tracked separately on `contributions` so the
  // positional expectations against the read-model UPSERT keep working.
  const capture: CapturedCall[] = [];
  const contributions: CapturedCall[] = [];
  const record = (call: CapturedCall): void => {
    if (call.sql.includes('rpt_event_contributions')) {
      contributions.push(call);
    } else {
      capture.push(call);
    }
  };
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      const call: CapturedCall = { sql, args };
      record(call);
      return handler?.(call) ?? [];
    },
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
      const call: CapturedCall = { sql, args };
      record(call);
      return handler?.(call) ?? 1;
    },
  };
  const tenantPrisma = {
    executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
  };
  return { capture, contributions, tenantPrisma };
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

/* =====================================================================
 * REVIEW-P2C15 R1 REGRESSION TESTS
 *
 * Pin the three blockers raised in the Round 1 review against
 * `2a3e835` + `a669917`:
 *
 *   BLOCKING 1 — additive UPSERTs are not idempotent under crash/redelivery
 *               without a per-source-event contribution ledger.
 *   BLOCKING 2 — batch materialisers were not school-scoped while writing
 *               per-school rows.
 *   BLOCKING 3 — workers trusted payload.schoolId without validating against
 *               the event envelope / current tenant school.
 * ===================================================================== */

describe('REVIEW-P2C15 R1 BLOCKING 1 — redelivery after partial failure', () => {
  it('second delivery of the same event_id is a no-op (claim hit) — counters do NOT double', async () => {
    // Simulate "contribution row already exists" by returning 0 from the
    // claim INSERT. The worker must skip the read-model UPSERT.
    const calls: CapturedCall[] = [];
    const contributions: CapturedCall[] = [];
    const client = {
      $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
        const call: CapturedCall = { sql, args };
        if (sql.includes('rpt_event_contributions')) contributions.push(call);
        else calls.push(call);
        return [];
      },
      $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
        const call: CapturedCall = { sql, args };
        if (sql.includes('rpt_event_contributions')) {
          contributions.push(call);
          // 0 rows affected = ON CONFLICT DO NOTHING already had a row
          return 0;
        }
        calls.push(call);
        return 1;
      },
    };
    const tenantPrisma = {
      executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
      executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    };
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
        'evt-dup',
      ),
      'dev.enr.application.submitted',
    );
    // Claim INSERT was attempted exactly once.
    expect(contributions.length).toBe(1);
    expect(contributions[0]!.sql).toContain('rpt_event_contributions');
    // Read-model UPSERT was SKIPPED because the claim returned 0 rows.
    expect(calls.length).toBe(0);
  });

  it('first delivery applies the UPSERT and writes one contribution row per target', async () => {
    const { capture, contributions, tenantPrisma } = makeFake();
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
          gameId: 'g-rep',
          schoolId: SCHOOL.schoolId,
          seasonId: 'aaaaaaaa-aaaa-7000-8000-000000000111',
          programmeId: 'bbbbbbbb-bbbb-7000-8000-000000000111',
          sport: 'BASKETBALL',
          homeScore: 80,
          awayScore: 70,
          result: 'WIN',
          completedAt: '2026-04-15',
        },
        'dev.ath.game.completed',
        'evt-ath-1',
      ),
    );
    // 2 read-model UPSERTs (rpt_game_results + rpt_ath_season_summary)
    expect(capture.length).toBe(2);
    // 2 contribution claims — one per target table
    expect(contributions.length).toBe(2);
    expect(contributions[0]!.sql).toContain('rpt_event_contributions');
    expect(contributions[1]!.sql).toContain('rpt_event_contributions');
    // Both contributions reference the SAME source_event_id but DIFFERENT target_table
    expect(contributions[0]!.args[1]).toBe('evt-ath-1');
    expect(contributions[1]!.args[1]).toBe('evt-ath-1');
    expect(contributions[0]!.args[2]).toBe('rpt_game_results');
    expect(contributions[1]!.args[2]).toBe('rpt_ath_season_summary');
  });
});

describe('REVIEW-P2C15 R1 BLOCKING 2 — batch materialisers school-scoped', () => {
  it('OfficialsReadModelWorker.materialise() JOINs through ath_programmes.school_id', async () => {
    const calls: CapturedCall[] = [];
    const client = {
      $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args });
        // First call is the existence probe — return one row so the worker
        // takes the real-aggregate branch.
        if (sql.includes('information_schema.tables')) return [{ ok: 1 }];
        return [{ total_assignments: 0, filled: 0, avg_cost_per_game: null }];
      },
      $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args });
        return 1;
      },
    };
    const tenantPrisma = {
      executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
      executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    };
    const { checkpoints } = makeCheckpointStub();
    const worker = new OfficialsReadModelWorker(tenantPrisma as never, checkpoints as never);
    await worker.materialise(SCHOOL.schoolId, '2026-04-06');

    // Find the aggregate SELECT
    const aggSelect = calls.find(
      (c) =>
        c.sql.includes('FROM ath_official_assignments') && c.sql.includes('JOIN ath_programmes'),
    );
    expect(aggSelect).toBeTruthy();
    // It JOINs to ath_programmes.school_id and binds the schoolId
    expect(aggSelect!.sql).toContain('pr.school_id = $2::uuid');
    expect(aggSelect!.args).toEqual(['2026-04-06', SCHOOL.schoolId]);
    // Also: the worker uses oa.fee (not oa.stipend — column rename bug fix)
    expect(aggSelect!.sql).toContain('AVG(oa.fee)');
    expect(aggSelect!.sql).not.toContain('AVG(stipend)');
  });
});

describe('REVIEW-P2C15 R1 BLOCKING 3 — payload schoolId must match envelope tenant.schoolId', () => {
  it('drops procurement event when payload.schoolId disagrees with envelope', async () => {
    const { capture, contributions, tenantPrisma } = makeFake();
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
          applicationId: 'app-bad',
          // School B in the payload, School A in the envelope
          schoolId: '019eeeee-eeee-7000-8000-bbbbbbbbbbbb',
          academicYearName: '2026-2027',
          submittedAt: '2026-04-15',
        },
        'dev.enr.application.submitted',
        'evt-mismatch',
      ),
      'dev.enr.application.submitted',
    );
    // NO contribution claim, NO read-model UPSERT — event is dropped
    expect(contributions.length).toBe(0);
    expect(capture.length).toBe(0);
  });

  it('drops wellbeing event when payload.schoolId disagrees with envelope', async () => {
    const { capture, contributions, tenantPrisma } = makeFake();
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
          responseId: 'r-bad',
          schoolId: '019eeeee-eeee-7000-8000-bbbbbbbbbbbb',
          gradeLevel: '5',
          domain: 'SAFETY' as const,
          numericResponse: 1,
          questionType: 'SCALE_1_5' as const,
          submittedAt: '2026-04-15',
        },
        'dev.svc.wellbeing.response.submitted',
        'evt-wb-mismatch',
      ),
    );
    expect(contributions.length).toBe(0);
    expect(capture.length).toBe(0);
  });
});
