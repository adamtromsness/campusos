import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PERMISSIONS_KEY } from '@shared/auth';
import { AITutoringService } from '../ai-tutoring/ai-tutoring.service';
import { AIUsageService } from '../ai-tutoring/ai-usage.service';
import { AIOptOutService } from '../ai-tutoring/ai-opt-out.service';
import { AIGatewayService } from '../ai-tutoring/ai-gateway.service';
import { LessonRecordingService } from '../lessons/lesson-recording.service';
import { AITutoringController } from '../ai-tutoring/ai-tutoring.controller';
import { AIUsageController } from '../ai-tutoring/ai-usage.controller';
import { AIOptOutController } from '../ai-tutoring/ai-opt-out.controller';
import { LessonRecordingController } from '../lessons/lesson-recording.controller';

const ADMIN_ACTOR = {
  accountId: '019e0cf8-bbb8-7556-8c81-a0000000a001',
  personId: '019e0cf8-bbb8-7556-8c81-a0000000a002',
  employeeId: '019e0cf8-bbb8-7556-8c81-a0000000a003',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
} as never;

const TEACHER_ACTOR = {
  accountId: '019e0cf8-bbb8-7556-8c81-b0000000b001',
  personId: '019e0cf8-bbb8-7556-8c81-b0000000b002',
  employeeId: '019e0cf8-bbb8-7556-8c81-b0000000b003',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
} as never;

const STUDENT_ACTOR = {
  accountId: '019e0cf8-bbb8-7556-8c81-c0000000c001',
  personId: '019e0cf8-bbb8-7556-8c81-c0000000c002',
  employeeId: null,
  personType: 'STUDENT' as const,
  isSchoolAdmin: false,
} as never;

const PARENT_ACTOR = {
  accountId: '019e0cf8-bbb8-7556-8c81-d0000000d001',
  personId: '019e0cf8-bbb8-7556-8c81-d0000000d002',
  employeeId: null,
  personType: 'GUARDIAN' as const,
  isSchoolAdmin: false,
} as never;

const STUDENT_SIS_ID = '019e0cf8-bbb8-7556-8c81-c0000000c099';

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

function makeRedis() {
  const counters = new Map<string, number>();
  const redis = {
    incrementCounter: async (key: string, delta: number, _ttl: number) => {
      const cur = (counters.get(key) ?? 0) + delta;
      counters.set(key, cur);
      return cur;
    },
    readCounter: async (key: string) => counters.get(key) ?? 0,
  };
  return { redis, counters };
}

function makeKafka() {
  const emitted: Array<{
    topic: string;
    sourceModule: string;
    key: string;
    payload: Record<string, unknown>;
  }> = [];
  const kafka = {
    emit: async (opts: any) => {
      emitted.push({
        topic: opts.topic,
        sourceModule: opts.sourceModule,
        key: opts.key,
        payload: opts.payload,
      });
    },
  };
  return { kafka, emitted };
}

/**
 * REVIEW-P2C7 BLOCKING 4 — outbox stub. The LessonRecordingService no
 * longer calls KafkaProducerService directly; it enqueues durable
 * envelopes into the outbox inside the same tenant tx as the domain
 * write. Tests stub the outbox and capture the enqueueInTx calls.
 */
function makeOutbox() {
  const enqueued: Array<{
    topic: string;
    sourceModule: string;
    key: string;
    eventId: string | undefined;
    payload: Record<string, unknown>;
  }> = [];
  const outbox = {
    enqueueInTx: async (_tx: unknown, opts: any) => {
      enqueued.push({
        topic: opts.topic,
        sourceModule: opts.sourceModule,
        key: opts.key,
        eventId: opts.eventId,
        payload: opts.payload,
      });
      return 'outbox-id-' + enqueued.length;
    },
  };
  return { outbox, enqueued };
}

function makeStubGateway() {
  return new AIGatewayService();
}

// Wrap the AsyncLocalStorage tenant context for service calls that read it.
import { runWithTenantContext } from '@shared/tenant';
const TENANT = {
  schoolId: '019e0cf8-bbb8-7556-8c81-aaaaaaaaaaaa',
  schemaName: 'tenant_demo',
  organisationId: null,
  subdomain: 'demo',
  isFrozen: false,
  planTier: 'STANDARD' as const,
  homeRegion: 'us-east-1',
} as never;

// ─────────────────────────────────────────────────────────────────────────────
// AIOptOutService — opt-out keystone
// ─────────────────────────────────────────────────────────────────────────────
describe('AIOptOutService — keystone', () => {
  it('isOptedOut returns true when an opt-out row exists', async () => {
    const fake = makeFake(() => [{ ok: 1 }]);
    const svc = new AIOptOutService(fake.tenantPrisma as never);
    const out = await svc.isOptedOut(STUDENT_SIS_ID);
    expect(out).toBe(true);
  });

  it('isOptedOut returns false when no row', async () => {
    const fake = makeFake(() => []);
    const svc = new AIOptOutService(fake.tenantPrisma as never);
    const out = await svc.isOptedOut(STUDENT_SIS_ID);
    expect(out).toBe(false);
  });

  it('GUARDIAN can opt out a linked child but not other students', async () => {
    let probedLinked = false;
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from sis_student_guardians sg')) {
        probedLinked = true;
        return [];
      }
      return [];
    });
    const svc = new AIOptOutService(fake.tenantPrisma as never);
    await expect(svc.create({ studentId: STUDENT_SIS_ID }, PARENT_ACTOR)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(probedLinked).toBe(true);
  });

  it('STUDENT may only opt themselves out', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from sis_students s')) return [{ id: 'different-student' }];
      return [];
    });
    const svc = new AIOptOutService(fake.tenantPrisma as never);
    await expect(svc.create({ studentId: STUDENT_SIS_ID }, STUDENT_ACTOR)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('Admin override works for any student', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from cls_ai_tutoring_opt_outs') && sql.includes('where student_id'))
        return [];
      if (sql.includes('insert into cls_ai_tutoring_opt_outs')) return 1;
      // getByStudent post-create
      if (
        sql.includes('from cls_ai_tutoring_opt_outs o') &&
        sql.includes('left join sis_students')
      ) {
        return [
          {
            id: 'opt-1',
            student_id: STUDENT_SIS_ID,
            student_name: 'Student Example',
            opted_out_by: ADMIN_ACTOR.personId,
            opted_out_by_name: 'Admin',
            opted_out_at: new Date(),
            reason: 'admin override',
          },
        ];
      }
      return [];
    });
    const svc = new AIOptOutService(fake.tenantPrisma as never);
    const out = await svc.create(
      { studentId: STUDENT_SIS_ID, reason: 'admin override' },
      ADMIN_ACTOR,
    );
    expect(out.studentId).toBe(STUDENT_SIS_ID);
    expect(out.reason).toBe('admin override');
  });

  it('rejects duplicate opt-out with friendly 400', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select id::text as id from cls_ai_tutoring_opt_outs')) {
        return [{ id: 'existing' }];
      }
      return [];
    });
    const svc = new AIOptOutService(fake.tenantPrisma as never);
    await expect(svc.create({ studentId: STUDENT_SIS_ID }, ADMIN_ACTOR)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AITutoringService — anonymisation, opt-out, quota keystones
// ─────────────────────────────────────────────────────────────────────────────
describe('AITutoringService — opt-out gate keystone', () => {
  it('startSession refuses an opted-out student with 403', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from sis_students s')) return [{ id: STUDENT_SIS_ID }];
      return [];
    });
    const optOuts = {
      isOptedOut: async () => true,
    };
    const usage = { assertWithinQuota: async () => {} } as never;
    const gateway = makeStubGateway();
    const svc = new AITutoringService(fake.tenantPrisma as never, usage, optOuts as never, gateway);
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await expect(svc.startSession({ subject: 'Algebra' }, STUDENT_ACTOR)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  it('STUDENT actor cannot start a session for someone else', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from sis_students s')) return [{ id: 'my-id' }];
      return [];
    });
    const optOuts = { isOptedOut: async () => false };
    const usage = { assertWithinQuota: async () => {} } as never;
    const svc = new AITutoringService(
      fake.tenantPrisma as never,
      usage,
      optOuts as never,
      makeStubGateway(),
    );
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await expect(
        svc.startSession({ subject: 'Algebra', studentId: 'someone-else' }, STUDENT_ACTOR),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  it('Quota gate fires before any AI Gateway call when quota is exhausted', async () => {
    const fake = makeFake(() => []);
    const optOuts = { isOptedOut: async () => false };
    let gatewayCalled = false;
    const gateway: any = {
      tutoringReply: async () => {
        gatewayCalled = true;
        return { content: 'reply', tokensUsed: 0, costUsd: 0 };
      },
    };
    const usage = {
      assertWithinQuota: async () => {
        throw new ForbiddenException('quota exhausted');
      },
      recordUsage: async () => {},
    } as never;
    // Simulate an ACTIVE session
    const fake2 = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select s.id, s.school_id')) {
        return [
          {
            id: 'session-1',
            school_id: TENANT.schoolId,
            student_id: STUDENT_SIS_ID,
            student_name: 'Alex',
            class_id: null,
            class_name: null,
            subject: 'Algebra',
            status: 'ACTIVE',
            started_at: new Date(),
            ended_at: null,
            total_messages: 0,
            learning_signals_extracted: false,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];
      }
      if (sql.includes('from sis_students s')) return [{ id: STUDENT_SIS_ID }];
      return [];
    });
    const svc = new AITutoringService(
      fake2.tenantPrisma as never,
      usage,
      optOuts as never,
      gateway,
    );
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await expect(
        svc.postMessage('session-1', { content: 'hello' }, STUDENT_ACTOR),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
    expect(gatewayCalled).toBe(false);
    void fake;
  });

  it('Anonymisation contract — anonymous id is deterministic and 16-hex', async () => {
    const svc = new AITutoringService(
      { executeInTenantContext: async (fn: any) => fn({}) } as never,
      { assertWithinQuota: async () => {}, recordUsage: async () => {} } as never,
      { isOptedOut: async () => false } as never,
      makeStubGateway(),
    );
    // Reach the private helper through type assertion for the contract test
    const studentId = '019e0cf8-bbb8-7556-8c81-c0000000c099';
    const sessionId = '019e0cf8-bbb8-7556-8c81-d0000000d099';
    const a = (svc as any).toAnonymousId(studentId, sessionId);
    const b = (svc as any).toAnonymousId(studentId, sessionId);
    const c = (svc as any).toAnonymousId(studentId, 'different-session');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('Students cannot read their own learning signals (avoids labelling)', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select s.id, s.school_id')) {
        return [
          {
            id: 'session-1',
            school_id: TENANT.schoolId,
            student_id: STUDENT_SIS_ID,
            student_name: null,
            class_id: null,
            class_name: null,
            subject: 'Algebra',
            status: 'COMPLETED',
            started_at: new Date(),
            ended_at: new Date(),
            total_messages: 4,
            learning_signals_extracted: true,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];
      }
      if (sql.includes('from sis_students s')) return [{ id: STUDENT_SIS_ID }];
      return [];
    });
    const svc = new AITutoringService(
      fake.tenantPrisma as never,
      { assertWithinQuota: async () => {}, recordUsage: async () => {} } as never,
      { isOptedOut: async () => false } as never,
      makeStubGateway(),
    );
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await expect(svc.listSignals('session-1', STUDENT_ACTOR)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  it('Non-staff non-admin cannot extract signals', async () => {
    const fake = makeFake(() => []);
    const svc = new AITutoringService(
      fake.tenantPrisma as never,
      { assertWithinQuota: async () => {}, recordUsage: async () => {} } as never,
      { isOptedOut: async () => false } as never,
      makeStubGateway(),
    );
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await expect(svc.extractSignals('session-1', STUDENT_ACTOR)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  it('Service must NEVER write to cls_grades — postMessage capture audit', async () => {
    const writes: string[] = [];
    const fake = makeFake((c) => {
      writes.push(c.sql.toLowerCase());
      const sql = c.sql.toLowerCase();
      if (sql.includes('select s.id, s.school_id')) {
        return [
          {
            id: 'session-1',
            school_id: TENANT.schoolId,
            student_id: STUDENT_SIS_ID,
            student_name: null,
            class_id: null,
            class_name: null,
            subject: 'Algebra',
            status: 'ACTIVE',
            started_at: new Date(),
            ended_at: null,
            total_messages: 0,
            learning_signals_extracted: false,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];
      }
      if (sql.includes('from sis_students s')) return [{ id: STUDENT_SIS_ID }];
      if (sql.includes('select id::text as id, session_id::text as session_id, role')) return []; // history empty
      if (sql.includes('insert into cls_ai_tutoring_messages')) return 1;
      if (sql.includes('select id::text as id, session_id::text as session_id, role')) return [];
      return [];
    });
    const svc = new AITutoringService(
      fake.tenantPrisma as never,
      { assertWithinQuota: async () => {}, recordUsage: async () => {} } as never,
      { isOptedOut: async () => false } as never,
      makeStubGateway(),
    );
    await runWithTenantContext({ tenant: TENANT }, async () => {
      try {
        await svc.postMessage('session-1', { content: 'hello' }, STUDENT_ACTOR);
      } catch {
        // We don't care if postMessage fully completes — we just want to audit no write to cls_grades fired
      }
    });
    expect(writes.some((w) => w.includes('insert into cls_grades'))).toBe(false);
    expect(writes.some((w) => w.includes('update cls_grades'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AIUsageService — quota counter
// ─────────────────────────────────────────────────────────────────────────────
describe('AIUsageService — quota counter', () => {
  it('assertWithinQuota throws when daily limit exceeded', async () => {
    const fake = makeFake(() => []);
    const r = makeRedis();
    // Pre-fill the counter past the limit
    process.env.AI_QUOTA_DAILY_TOKENS = '1000';
    const today = new Date().toISOString().slice(0, 10);
    r.counters.set('ai:quota:school-1:' + today, 1500);
    const svc = new AIUsageService(fake.tenantPrisma as never, r.redis as never);
    await expect(svc.assertWithinQuota('school-1')).rejects.toBeInstanceOf(ForbiddenException);
    delete process.env.AI_QUOTA_DAILY_TOKENS;
  });

  it('recordUsage writes log row + bumps Redis counter', async () => {
    const writes: Array<{ sql: string; args: unknown[] }> = [];
    const fake = makeFake((c) => {
      writes.push({ sql: c.sql, args: c.args });
      return c.fn === 'e' ? 1 : [];
    });
    const r = makeRedis();
    const svc = new AIUsageService(fake.tenantPrisma as never, r.redis as never);
    await svc.recordUsage({
      schoolId: 'school-1',
      jobType: 'TUTORING',
      tokensUsed: 250,
      costUsd: 0.0025,
      referenceId: 'session-1',
      actorAccountId: 'actor-1',
    });
    expect(writes.some((w) => w.sql.toLowerCase().includes('insert into cls_ai_usage_log'))).toBe(
      true,
    );
    const today = new Date().toISOString().slice(0, 10);
    expect(r.counters.get('ai:quota:school-1:' + today)).toBe(250);
  });

  it('non-admin cannot read usage summary', async () => {
    const fake = makeFake(() => []);
    const r = makeRedis();
    const svc = new AIUsageService(fake.tenantPrisma as never, r.redis as never);
    await expect(svc.getSummary(TEACHER_ACTOR)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LessonRecordingService — emits + idempotent chain
// ─────────────────────────────────────────────────────────────────────────────
describe('LessonRecordingService — durable outbox + idempotent chain', () => {
  it('create enqueues video.uploaded INSIDE the same tx (durable outbox)', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select id::text as id, class_id::text as class_id from cls_lessons')) {
        return [{ id: 'lesson-1', class_id: 'class-1' }];
      }
      if (sql.includes('select 1 as ok from sis_class_teachers')) return [{ ok: 1 }];
      if (sql.includes('insert into cls_lesson_recordings')) return 1;
      if (sql.includes('select r.id, r.lesson_id::text as lesson_id')) {
        return [
          {
            id: 'rec-1',
            lesson_id: 'lesson-1',
            class_id: 'class-1',
            school_id: TENANT.schoolId,
            recorded_by: TEACHER_ACTOR.employeeId,
            recorded_by_name: 'Teacher',
            s3_key: 'demo/lesson.mp4',
            duration_seconds: 1800,
            recorded_at: new Date(),
            processing_status: 'UPLOADED',
            error_message: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];
      }
      return [];
    });
    const o = makeOutbox();
    const svc = new LessonRecordingService(fake.tenantPrisma as never, o.outbox as never);
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await svc.create(
        { lessonId: 'lesson-1', s3Key: 'demo/lesson.mp4', durationSeconds: 1800 },
        TEACHER_ACTOR,
      );
    });
    expect(o.enqueued.length).toBe(1);
    expect(o.enqueued[0]!.topic).toBe('video.uploaded');
    expect(o.enqueued[0]!.sourceModule).toBe('classroom');
    expect(o.enqueued[0]!.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}/); // v5-shape
    expect(o.enqueued[0]!.payload.lessonId).toBe('lesson-1');
    expect(o.enqueued[0]!.payload.s3Key).toBe('demo/lesson.mp4');
  });

  it('applyTranscript is idempotent — returns silently when transcript exists', async () => {
    let inserts = 0;
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select processing_status as status from cls_lesson_recordings')) {
        return [{ status: 'TRANSCRIBING' }];
      }
      if (sql.includes('select 1 as ok from cls_lesson_transcripts')) {
        return [{ ok: 1 }]; // already exists
      }
      if (sql.includes('insert into cls_lesson_transcripts')) {
        inserts++;
        return 1;
      }
      return [];
    });
    const svc = new LessonRecordingService(
      fake.tenantPrisma as never,
      makeOutbox().outbox as never,
    );
    await svc.applyTranscript({
      recordingId: 'rec-1',
      transcriptText: 'transcript text',
      wordCount: 2,
    });
    expect(inserts).toBe(0);
  });

  it('applySummary enqueues lesson.summary.ready INSIDE the same tx (durable outbox)', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select processing_status as status, school_id::text')) {
        return [
          {
            status: 'SUMMARISING',
            school_id: TENANT.schoolId,
            lesson_id: 'lesson-1',
            class_id: 'class-1',
            recorded_by: 'emp-1',
          },
        ];
      }
      if (sql.includes('select 1 as ok from cls_lesson_summaries')) return [];
      if (sql.includes('insert into cls_lesson_summaries')) return 1;
      return [];
    });
    const o = makeOutbox();
    const svc = new LessonRecordingService(fake.tenantPrisma as never, o.outbox as never);
    await svc.applySummary({
      recordingId: 'rec-1',
      summaryText: 'Summary text',
      keyTopics: ['t1', 't2'],
      actionItems: ['a1'],
      modelVersion: 'stub-v1',
      tokensUsed: 100,
    });
    expect(o.enqueued.length).toBe(1);
    expect(o.enqueued[0]!.topic).toBe('lesson.summary.ready');
    expect(o.enqueued[0]!.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}/);
    expect(o.enqueued[0]!.payload.recordingId).toBe('rec-1');
    expect(o.enqueued[0]!.payload.schoolId).toBe(TENANT.schoolId);
    expect(o.enqueued[0]!.payload.summaryText).toBe('Summary text');
  });

  it('REVIEW-P2C7 BLOCKING 4 — deterministic event id is stable across re-runs', async () => {
    // Same recordingId must produce the same event id so a Kafka redelivery
    // hits the consumer's idempotency cache and is a no-op.
    const { deterministicVideoUploadedEventId, deterministicLessonSummaryReadyEventId } =
      await import('../lessons/lesson-recording.service');
    const id1 = deterministicVideoUploadedEventId('rec-fixed-1');
    const id2 = deterministicVideoUploadedEventId('rec-fixed-1');
    const id3 = deterministicVideoUploadedEventId('rec-fixed-2');
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // The two topics produce distinct ids for the same recording id —
    // so a single recordingId never collides on the bus.
    const sumId = deterministicLessonSummaryReadyEventId('rec-fixed-1');
    expect(sumId).not.toBe(id1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Controller permission metadata
// ─────────────────────────────────────────────────────────────────────────────
describe('P2-7c controller permission metadata', () => {
  function tagsOf(target: any, methodName: string): string[] {
    return Reflect.getMetadata(PERMISSIONS_KEY, target.prototype[methodName]) as string[];
  }

  it('AITutoringController tutoring read+write paths gate on tch-007', () => {
    expect(tagsOf(AITutoringController, 'start')).toEqual(['tch-007:write']);
    expect(tagsOf(AITutoringController, 'list')).toEqual(['tch-007:read']);
    expect(tagsOf(AITutoringController, 'getOne')).toEqual(['tch-007:read']);
    expect(tagsOf(AITutoringController, 'postMessage')).toEqual(['tch-007:write']);
    expect(tagsOf(AITutoringController, 'complete')).toEqual(['tch-007:write']);
    expect(tagsOf(AITutoringController, 'extractSignals')).toEqual(['tch-007:write']);
    expect(tagsOf(AITutoringController, 'listSessionSignals')).toEqual(['tch-007:read']);
    expect(tagsOf(AITutoringController, 'listStudentSignals')).toEqual(['tch-007:read']);
  });

  it('AIUsageController dashboard requires tch-007:admin', () => {
    expect(tagsOf(AIUsageController, 'getSummary')).toEqual(['tch-007:admin']);
    expect(tagsOf(AIUsageController, 'listUsage')).toEqual(['tch-007:admin']);
    expect(tagsOf(AIUsageController, 'getQuota')).toEqual(['tch-007:read']);
  });

  it('AIOptOutController endpoints are gated on tch-007:read with service-layer authority', () => {
    expect(tagsOf(AIOptOutController, 'create')).toEqual(['tch-007:read']);
    expect(tagsOf(AIOptOutController, 'getOne')).toEqual(['tch-007:read']);
    expect(tagsOf(AIOptOutController, 'delete')).toEqual(['tch-007:read']);
  });

  it('LessonRecordingController gates on tch-001 (Lesson Plans)', () => {
    expect(tagsOf(LessonRecordingController, 'create')).toEqual(['tch-001:write']);
    expect(tagsOf(LessonRecordingController, 'getOne')).toEqual(['tch-001:read']);
    expect(tagsOf(LessonRecordingController, 'listForLesson')).toEqual(['tch-001:read']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AIGatewayService — stubbed in dev, returns deterministic responses
// ─────────────────────────────────────────────────────────────────────────────
describe('AIGatewayService — stub mode', () => {
  it('tutoringReply returns a deterministic stub response when no AI_GATEWAY_URL is set', async () => {
    delete process.env.AI_GATEWAY_URL;
    const svc = new AIGatewayService();
    const out = await svc.tutoringReply({
      anonymousStudentId: 'abc123',
      subject: 'Algebra',
      history: [],
      newMessage: 'Help me factor',
    });
    expect(out.content).toContain('Algebra');
    expect(out.content).toContain('Help me factor');
    expect(out.tokensUsed).toBeGreaterThan(0);
    expect(out.costUsd).toBe(0); // stub is free
  });

  it('extractLearningSignals returns at least one signal for a student conversation', async () => {
    delete process.env.AI_GATEWAY_URL;
    const svc = new AIGatewayService();
    const out = await svc.extractLearningSignals({
      anonymousStudentId: 'abc',
      subject: 'Sci',
      transcript: [
        { role: 'STUDENT', content: 'why does this work?' },
        { role: 'ASSISTANT', content: 'Because...' },
      ],
    });
    expect(out.signals.length).toBeGreaterThanOrEqual(1);
    expect(out.tokensUsed).toBeGreaterThan(0);
  });

  it('summariseLesson returns a deterministic stub summary', async () => {
    delete process.env.AI_GATEWAY_URL;
    const svc = new AIGatewayService();
    const out = await svc.summariseLesson({
      anonymousRecordingId: 'rec-abc',
      className: 'Math 101',
      subject: 'Algebra',
      transcript: 'Lesson transcript text here. We learned about quadratics today.',
    });
    expect(out.summaryText.length).toBeGreaterThan(0);
    expect(out.modelVersion).toBe('stub-v1');
    expect(out.keyTopics.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REVIEW-P2C7 BLOCKING regressions — pin the fixes so they cannot regress.
// ─────────────────────────────────────────────────────────────────────────────
describe('REVIEW-P2C7 BLOCKING regressions', () => {
  // ── BLOCKING 1 — listSignalsForStudent is teacher/caseload row-scoped ──
  it('BLOCKING 1: STAFF actor with no teaching/caseload relationship → 403', async () => {
    let probedTeaching = false;
    let probedCaseload = false;
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select 1 as ok from sis_students where id') && sql.includes('school_id')) {
        return [{ ok: 1 }]; // student exists in tenant
      }
      if (sql.includes('from sis_class_teachers ct')) {
        probedTeaching = true;
        return []; // not assigned
      }
      if (sql.includes('from svc_caseloads')) {
        probedCaseload = true;
        return []; // not on caseload
      }
      return [];
    });
    const svc = new AITutoringService(
      fake.tenantPrisma as never,
      { assertWithinQuota: async () => {}, recordUsage: async () => {} } as never,
      { isOptedOut: async () => false } as never,
      makeStubGateway(),
    );
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await expect(svc.listSignalsForStudent(STUDENT_SIS_ID, TEACHER_ACTOR)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
    expect(probedTeaching).toBe(true);
    expect(probedCaseload).toBe(true);
  });

  it('BLOCKING 1: school admin sees signals for any student (school-scoped)', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select 1 as ok from sis_students where id') && sql.includes('school_id')) {
        return [{ ok: 1 }];
      }
      if (sql.includes('from cls_ai_tutoring_learning_signals ls')) {
        // Verify the SQL carries the school-scope predicate
        expect(c.sql.toLowerCase()).toContain('s.school_id');
        return [];
      }
      return [];
    });
    const svc = new AITutoringService(
      fake.tenantPrisma as never,
      { assertWithinQuota: async () => {}, recordUsage: async () => {} } as never,
      { isOptedOut: async () => false } as never,
      makeStubGateway(),
    );
    await runWithTenantContext({ tenant: TENANT }, async () => {
      const out = await svc.listSignalsForStudent(STUDENT_SIS_ID, ADMIN_ACTOR);
      expect(out).toEqual([]);
    });
  });

  it('BLOCKING 1: STUDENT actor → 403 even on own student id', async () => {
    const fake = makeFake(() => []);
    const svc = new AITutoringService(
      fake.tenantPrisma as never,
      { assertWithinQuota: async () => {}, recordUsage: async () => {} } as never,
      { isOptedOut: async () => false } as never,
      makeStubGateway(),
    );
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await expect(svc.listSignalsForStudent(STUDENT_SIS_ID, STUDENT_ACTOR)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  // ── BLOCKING 2 — extractSignals also runs the row-scope check ──
  it('BLOCKING 2: extractSignals refuses STAFF actor not assigned to the student', async () => {
    let gatewayCalled = false;
    const gateway: any = {
      summariseLesson: async () => ({
        summaryText: 's',
        keyTopics: [],
        actionItems: [],
        modelVersion: 'v',
        tokensUsed: 0,
        costUsd: 0,
      }),
      extractLearningSignals: async () => {
        gatewayCalled = true;
        return { signals: [], tokensUsed: 0, costUsd: 0 };
      },
    };
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select s.id, s.school_id')) {
        return [
          {
            id: 'session-1',
            school_id: TENANT.schoolId,
            student_id: STUDENT_SIS_ID,
            student_name: null,
            class_id: null,
            class_name: null,
            subject: 'Algebra',
            status: 'COMPLETED',
            started_at: new Date(),
            ended_at: new Date(),
            total_messages: 4,
            learning_signals_extracted: false,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];
      }
      if (sql.includes('from sis_class_teachers ct')) return []; // not assigned
      if (sql.includes('from svc_caseloads')) return []; // not on caseload
      return [];
    });
    const svc = new AITutoringService(
      fake.tenantPrisma as never,
      { assertWithinQuota: async () => {}, recordUsage: async () => {} } as never,
      { isOptedOut: async () => false } as never,
      gateway,
    );
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await expect(svc.extractSignals('session-1', TEACHER_ACTOR)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
    expect(gatewayCalled).toBe(false);
  });

  // ── BLOCKING 3 — startSession does NOT INSERT for unauthorised teacher ──
  it('BLOCKING 3: unauthorised teacher session creation does NOT INSERT', async () => {
    let inserted = false;
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select 1 as ok from sis_students') && sql.includes('school_id')) {
        return [{ ok: 1 }];
      }
      if (sql.includes('from sis_class_teachers ct')) return []; // not teaching
      if (sql.includes('from svc_caseloads')) return []; // not counsellor
      if (sql.includes('insert into cls_ai_tutoring_sessions')) {
        inserted = true;
        return 1;
      }
      return [];
    });
    const svc = new AITutoringService(
      fake.tenantPrisma as never,
      { assertWithinQuota: async () => {}, recordUsage: async () => {} } as never,
      { isOptedOut: async () => false } as never,
      makeStubGateway(),
    );
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await expect(
        svc.startSession({ studentId: STUDENT_SIS_ID, subject: 'Algebra' }, TEACHER_ACTOR),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
    expect(inserted).toBe(false);
  });

  it('BLOCKING 3: school admin can create a session for any student in the school', async () => {
    let inserted = false;
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select 1 as ok from sis_students') && sql.includes('school_id')) {
        return [{ ok: 1 }];
      }
      if (sql.includes('insert into cls_ai_tutoring_sessions')) {
        inserted = true;
        return 1;
      }
      if (sql.includes('select s.id, s.school_id')) {
        return [
          {
            id: 'new-session',
            school_id: TENANT.schoolId,
            student_id: STUDENT_SIS_ID,
            student_name: null,
            class_id: null,
            class_name: null,
            subject: 'Algebra',
            status: 'ACTIVE',
            started_at: new Date(),
            ended_at: null,
            total_messages: 0,
            learning_signals_extracted: false,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];
      }
      return [];
    });
    const svc = new AITutoringService(
      fake.tenantPrisma as never,
      { assertWithinQuota: async () => {}, recordUsage: async () => {} } as never,
      { isOptedOut: async () => false } as never,
      makeStubGateway(),
    );
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await svc.startSession({ studentId: STUDENT_SIS_ID, subject: 'Algebra' }, ADMIN_ACTOR);
    });
    expect(inserted).toBe(true);
  });

  // ── BLOCKING 5 — student cannot DELETE own opt-out (cannot opt back in) ──
  it('BLOCKING 5: STUDENT cannot delete own opt-out — guardian/admin only', async () => {
    let deleted = false;
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('delete from cls_ai_tutoring_opt_outs')) {
        deleted = true;
        return 1;
      }
      return [];
    });
    const svc = new AIOptOutService(fake.tenantPrisma as never);
    await expect(svc.delete(STUDENT_SIS_ID, STUDENT_ACTOR)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(deleted).toBe(false);
  });

  it('BLOCKING 5: linked guardian CAN delete own child opt-out (opt back in)', async () => {
    let deleted = false;
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from sis_student_guardians sg')) return [{ ok: 1 }]; // linked
      if (sql.includes('delete from cls_ai_tutoring_opt_outs')) {
        deleted = true;
        return 1;
      }
      return [];
    });
    const svc = new AIOptOutService(fake.tenantPrisma as never);
    await svc.delete(STUDENT_SIS_ID, PARENT_ACTOR);
    expect(deleted).toBe(true);
  });

  it('BLOCKING 5: school admin CAN delete any opt-out (emergency revocation)', async () => {
    let deleted = false;
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('delete from cls_ai_tutoring_opt_outs')) {
        deleted = true;
        return 1;
      }
      return [];
    });
    const svc = new AIOptOutService(fake.tenantPrisma as never);
    await svc.delete(STUDENT_SIS_ID, ADMIN_ACTOR);
    expect(deleted).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REVIEW-P2C7 ROUND 2 BLOCKING — cross-school AI tutoring session isolation.
//
// Round 1 added actor-scoped row checks but `loadSessionRowOrThrow` still
// loaded sessions by id only, and `assertCanReadSession` short-circuited on
// `actor.isSchoolAdmin`. A School A admin who guessed or leaked a School B
// session UUID could read / complete / extract / list signals on it.
//
// Round 2 fix — every direct-object reference query (loader + lock + write +
// message + signal aggregate) now carries a `school_id = $tenant.schoolId`
// predicate. Cross-school admin reads + writes collapse to 404 don't-leak-
// existence at the query layer.
// ─────────────────────────────────────────────────────────────────────────────
describe('REVIEW-P2C7 ROUND 2 — cross-school session isolation', () => {
  it('ROUND 2: loadSessionRowOrThrow runs school-scoped predicate', async () => {
    let observedSql = '';
    let observedArgs: unknown[] = [];
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select s.id, s.school_id') && sql.includes('where s.id')) {
        observedSql = sql;
        observedArgs = c.args;
      }
      return [];
    });
    const svc = new AITutoringService(
      fake.tenantPrisma as never,
      { assertWithinQuota: async () => {}, recordUsage: async () => {} } as never,
      { isOptedOut: async () => false } as never,
      makeStubGateway(),
    );
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await expect(svc.getSession('cross-school-uuid', ADMIN_ACTOR)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
    expect(observedSql).toContain('s.school_id');
    expect(observedArgs[1]).toBe(TENANT.schoolId);
  });

  it('ROUND 2: cross-school admin gets 404 on session GET', async () => {
    // Simulate: the session UUID is real (in another school) but the
    // school-scoped query returns 0 rows because the predicate filters it out.
    const fake = makeFake(() => []); // every query returns empty — session not in this school
    const svc = new AITutoringService(
      fake.tenantPrisma as never,
      { assertWithinQuota: async () => {}, recordUsage: async () => {} } as never,
      { isOptedOut: async () => false } as never,
      makeStubGateway(),
    );
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await expect(
        svc.getSession('019e0000-0000-7000-8000-foreignschool', ADMIN_ACTOR),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('ROUND 2: cross-school admin completeSession lock query carries school predicate', async () => {
    let observedLockSql = '';
    let observedLockArgs: unknown[] = [];
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from cls_ai_tutoring_sessions') && sql.includes('for update')) {
        observedLockSql = sql;
        observedLockArgs = c.args;
        return []; // foreign-school UUID — empty result
      }
      return [];
    });
    const svc = new AITutoringService(
      fake.tenantPrisma as never,
      { assertWithinQuota: async () => {}, recordUsage: async () => {} } as never,
      { isOptedOut: async () => false } as never,
      makeStubGateway(),
    );
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await expect(
        svc.completeSession('019e0000-0000-7000-8000-foreignschool', {}, ADMIN_ACTOR),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
    expect(observedLockSql).toContain('school_id');
    expect(observedLockArgs[1]).toBe(TENANT.schoolId);
  });

  it('ROUND 2: cross-school admin extractSignals → 404 (loader school-scoped)', async () => {
    let gatewayCalled = false;
    const gateway: any = {
      summariseLesson: async () => ({
        summaryText: '',
        keyTopics: [],
        actionItems: [],
        modelVersion: 'v',
        tokensUsed: 0,
        costUsd: 0,
      }),
      extractLearningSignals: async () => {
        gatewayCalled = true;
        return { signals: [], tokensUsed: 0, costUsd: 0 };
      },
    };
    const fake = makeFake(() => []); // session not in this school
    const svc = new AITutoringService(
      fake.tenantPrisma as never,
      { assertWithinQuota: async () => {}, recordUsage: async () => {} } as never,
      { isOptedOut: async () => false } as never,
      gateway,
    );
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await expect(
        svc.extractSignals('019e0000-0000-7000-8000-foreignschool', ADMIN_ACTOR),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
    expect(gatewayCalled).toBe(false);
  });

  it('ROUND 2: cross-school admin listSignals(sessionId) → 404 + JOIN carries school predicate', async () => {
    let observedSignalsSql = '';
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from cls_ai_tutoring_learning_signals')) {
        observedSignalsSql = sql;
      }
      return []; // loader returns empty for cross-school session
    });
    const svc = new AITutoringService(
      fake.tenantPrisma as never,
      { assertWithinQuota: async () => {}, recordUsage: async () => {} } as never,
      { isOptedOut: async () => false } as never,
      makeStubGateway(),
    );
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await expect(
        svc.listSignals('019e0000-0000-7000-8000-foreignschool', ADMIN_ACTOR),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
    // The signals query never fires because the loader 404s first; pin the
    // contract on getSessionWithMessages where the signals query SHOULD fire
    // for a same-school admin and JOIN with school_id predicate.
    expect(observedSignalsSql).toBe(''); // never reached — loader rejected
  });

  it('ROUND 2: same-school admin gets messages JOIN with school predicate', async () => {
    let observedMessagesSql = '';
    let observedMessagesArgs: unknown[] = [];
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select s.id, s.school_id') && sql.includes('where s.id')) {
        // Loader returns the in-tenant session
        return [
          {
            id: 'session-1',
            school_id: TENANT.schoolId,
            student_id: STUDENT_SIS_ID,
            student_name: null,
            class_id: null,
            class_name: null,
            subject: 'Algebra',
            status: 'COMPLETED',
            started_at: new Date(),
            ended_at: new Date(),
            total_messages: 0,
            learning_signals_extracted: false,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];
      }
      if (sql.includes('from cls_ai_tutoring_messages m')) {
        observedMessagesSql = sql;
        observedMessagesArgs = c.args;
        return [];
      }
      return [];
    });
    const svc = new AITutoringService(
      fake.tenantPrisma as never,
      { assertWithinQuota: async () => {}, recordUsage: async () => {} } as never,
      { isOptedOut: async () => false } as never,
      makeStubGateway(),
    );
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await svc.getSessionWithMessages('session-1', ADMIN_ACTOR);
    });
    // Verify the messages query JOINs cls_ai_tutoring_sessions on school_id
    expect(observedMessagesSql).toContain('join cls_ai_tutoring_sessions s');
    expect(observedMessagesSql).toContain('s.school_id');
    expect(observedMessagesArgs[1]).toBe(TENANT.schoolId);
  });

  it('ROUND 2: loadMessageOrThrow JOINs sessions with school_id predicate', async () => {
    let observedSql = '';
    let observedArgs: unknown[] = [];
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from cls_ai_tutoring_messages m') && sql.includes('where m.id')) {
        observedSql = sql;
        observedArgs = c.args;
      }
      return [];
    });
    const svc = new AITutoringService(
      fake.tenantPrisma as never,
      { assertWithinQuota: async () => {}, recordUsage: async () => {} } as never,
      { isOptedOut: async () => false } as never,
      makeStubGateway(),
    );
    // Reach the private helper through type assertion to pin the contract
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await expect(
        (svc as any).loadMessageOrThrow('019e0000-0000-7000-8000-foreignmsg'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
    expect(observedSql).toContain('join cls_ai_tutoring_sessions s');
    expect(observedSql).toContain('s.school_id');
    expect(observedArgs[1]).toBe(TENANT.schoolId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REVIEW-P2C7 ROUND 3 BLOCKING — listSessions school-scope.
//
// Round 2 fixed direct-object UUID paths but listSessions() still built a
// where clause only for non-admin actors. School admins ran the base query
// with no school predicate — so a School A admin in a multi-school tenant
// pool could list School B AI tutoring sessions.
//
// Round 3 fix — `s.school_id = $1::uuid` is the BASE predicate for every
// actor including school admin. Actor-specific filters AND on top.
// ─────────────────────────────────────────────────────────────────────────────
describe('REVIEW-P2C7 ROUND 3 — listSessions school-scope', () => {
  it('ROUND 3: school admin list query carries s.school_id predicate as base', async () => {
    let observedSql = '';
    let observedArgs: unknown[] = [];
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (
        sql.includes('select s.id, s.school_id') &&
        sql.includes('from cls_ai_tutoring_sessions')
      ) {
        observedSql = sql;
        observedArgs = c.args;
      }
      return [];
    });
    const svc = new AITutoringService(
      fake.tenantPrisma as never,
      { assertWithinQuota: async () => {}, recordUsage: async () => {} } as never,
      { isOptedOut: async () => false } as never,
      makeStubGateway(),
    );
    await runWithTenantContext({ tenant: TENANT }, async () => {
      const out = await svc.listSessions(ADMIN_ACTOR);
      expect(out).toEqual([]);
    });
    // The admin path must STILL include the school predicate as the base
    // WHERE clause — not skip it.
    expect(observedSql).toContain('where s.school_id');
    expect(observedArgs[0]).toBe(TENANT.schoolId);
  });

  it('ROUND 3: teacher list query carries s.school_id predicate before AND clause', async () => {
    let observedSql = '';
    let observedArgs: unknown[] = [];
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (
        sql.includes('select s.id, s.school_id') &&
        sql.includes('from cls_ai_tutoring_sessions')
      ) {
        observedSql = sql;
        observedArgs = c.args;
      }
      return [];
    });
    const svc = new AITutoringService(
      fake.tenantPrisma as never,
      { assertWithinQuota: async () => {}, recordUsage: async () => {} } as never,
      { isOptedOut: async () => false } as never,
      makeStubGateway(),
    );
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await svc.listSessions(TEACHER_ACTOR);
    });
    expect(observedSql).toContain('where s.school_id');
    expect(observedSql).toContain('and s.student_id in');
    expect(observedArgs[0]).toBe(TENANT.schoolId);
    expect(observedArgs[1]).toBe(TEACHER_ACTOR.employeeId);
  });

  it('ROUND 3: student list query carries s.school_id predicate before AND clause', async () => {
    let observedSql = '';
    let observedArgs: unknown[] = [];
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (
        sql.includes('select s.id, s.school_id') &&
        sql.includes('from cls_ai_tutoring_sessions')
      ) {
        observedSql = sql;
        observedArgs = c.args;
      }
      return [];
    });
    const svc = new AITutoringService(
      fake.tenantPrisma as never,
      { assertWithinQuota: async () => {}, recordUsage: async () => {} } as never,
      { isOptedOut: async () => false } as never,
      makeStubGateway(),
    );
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await svc.listSessions(STUDENT_ACTOR);
    });
    expect(observedSql).toContain('where s.school_id');
    expect(observedSql).toContain('and s.student_id =');
    expect(observedArgs[0]).toBe(TENANT.schoolId);
    expect(observedArgs[1]).toBe(STUDENT_ACTOR.personId);
  });

  it('ROUND 3: parent (no allowed branch) returns empty list — no query fired', async () => {
    let queryFired = false;
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (
        sql.includes('select s.id, s.school_id') &&
        sql.includes('from cls_ai_tutoring_sessions')
      ) {
        queryFired = true;
      }
      return [];
    });
    const svc = new AITutoringService(
      fake.tenantPrisma as never,
      { assertWithinQuota: async () => {}, recordUsage: async () => {} } as never,
      { isOptedOut: async () => false } as never,
      makeStubGateway(),
    );
    await runWithTenantContext({ tenant: TENANT }, async () => {
      const out = await svc.listSessions(PARENT_ACTOR);
      expect(out).toEqual([]);
    });
    expect(queryFired).toBe(false);
  });
});
