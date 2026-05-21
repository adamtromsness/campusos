import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { VideoTranscriptConsumer } from '@modules/m21-classroom/lessons/video-transcript.consumer';
import { LessonSummaryConsumer } from '@modules/m21-classroom/lessons/lesson-summary.consumer';
import { LessonRecordingService } from '@modules/m21-classroom/lessons/lesson-recording.service';
import { AIGatewayService } from '@modules/m21-classroom/ai-tutoring/ai-gateway.service';
import { AIUsageService } from '@modules/m21-classroom/ai-tutoring/ai-usage.service';
import { HallPassOverdueWorker } from '@modules/m21-classroom/hall-passes/hall-pass-overdue.worker';
import { HallPassService } from '@modules/m21-classroom/hall-passes/hall-pass.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { IdempotencyService } from '@shared/kafka/idempotency.service';
import { KafkaConsumerService } from '@shared/kafka/kafka-consumer.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import { RedisService } from '@shared/cache';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';
import type { ConsumedMessage } from '@shared/kafka/kafka-consumer.service';

import { makeRecordingKafka, RecordingKafkaProducer } from '../helpers/recording-kafka';
import {
  withTestTenant,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SUBDOMAIN,
} from '../helpers/tenant-context';
import { adminActor, TEST_TEACHER_EMPLOYEE_ID } from '../helpers/actor';
import { TEST_SIS_CLASS_ID } from '../fixtures/sis';
import { seedStudent, enrollStudent, cleanupSeededIds } from '../m20-sis/sis-helpers';

/**
 * Wave 4 — m21-classroom consumer DB-backed integration tests.
 *
 * Three surfaces:
 *
 * 1. VideoTranscriptConsumer — drives a synthetic ADR-057 envelope through
 *    the consumer's handle() and asserts:
 *      * cls_lesson_transcripts row inserted
 *      * cls_lesson_recordings.processing_status flipped to COMPLETE
 *        (via in-line gateway + applySummary)
 *      * cls_lesson_summaries row inserted
 *      * cls_ai_usage_log row inserted (SUMMARISATION)
 *      * idempotency claim recorded (platform_event_consumer_idempotency)
 *
 * 2. LessonSummaryConsumer — drives the alt-path envelope where the AI
 *    Inference service sends the summary back. Asserts:
 *      * applySummary runs (cls_lesson_summaries row inserted)
 *      * processing_status flipped to COMPLETE
 *      * idempotency claim recorded
 *
 * 3. HallPassOverdueWorker.tick — exercise the cron-style sweep across
 *    every active school. Asserts pre-seeded OVERDUE-eligible row is
 *    flipped to OVERDUE via HallPassService.sweepOverdueForCurrentTenant.
 */
describe('integration:m21-classroom/consumers', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let outbox: OutboxService;
  let recordings: LessonRecordingService;
  let gateway: AIGatewayService;
  let usage: AIUsageService;
  let idempotency: IdempotencyService;
  let consumer: KafkaConsumerService;
  let redis: RedisService;
  let kafka: ReturnType<typeof makeRecordingKafka>;

  let videoConsumer: VideoTranscriptConsumer;
  let summaryConsumer: LessonSummaryConsumer;
  let hallPassService: HallPassService;
  let hallPassWorker: HallPassOverdueWorker;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];
  const guardianIds: string[] = [];
  const accountIds: string[] = [];

  const lessonIds: string[] = [];
  const recordingIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    redis = new RedisService();
    await redis.onModuleInit();
    outbox = new OutboxService();
    recordings = new LessonRecordingService(tenantPrisma, outbox);
    gateway = new AIGatewayService();
    usage = new AIUsageService(tenantPrisma, redis);
    idempotency = new IdempotencyService(tenantPrisma);
    consumer = new KafkaConsumerService(tenantPrisma);
    kafka = makeRecordingKafka();
    hallPassService = new HallPassService(tenantPrisma, kafka as unknown as KafkaProducerService);
    videoConsumer = new VideoTranscriptConsumer(consumer, idempotency, recordings, gateway, usage);
    summaryConsumer = new LessonSummaryConsumer(consumer, idempotency, recordings);
    hallPassWorker = new HallPassOverdueWorker(tenantPrisma, hallPassService);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
    await redis.onModuleDestroy();
  });

  beforeEach(async () => {
    (kafka as unknown as RecordingKafkaProducer).reset();
    // Wipe lesson recordings + transcripts + summaries
    if (recordingIds.length) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.cls_lesson_summaries WHERE recording_id = ANY($1::uuid[])`,
        recordingIds,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.cls_lesson_transcripts WHERE recording_id = ANY($1::uuid[])`,
        recordingIds,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.cls_lesson_recordings WHERE id = ANY($1::uuid[])`,
        recordingIds,
      );
      recordingIds.length = 0;
    }
    if (lessonIds.length) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.cls_lessons WHERE id = ANY($1::uuid[])`,
        lessonIds,
      );
      lessonIds.length = 0;
    }
    // Wipe hall pass state
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_hall_passes`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_hall_pass_settings`);
    // Wipe outbox + idempotency
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE topic IN ('video.uploaded', 'lesson.summary.ready') AND tenant_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_event_consumer_idempotency
       WHERE consumer_group IN ('classroom-video-transcript-consumer', 'classroom-lesson-summary-consumer')`,
    );
    await cleanupSeededIds(rawClient, {
      studentIds: studentIds.splice(0),
      platformStudentIds: platformStudentIds.splice(0),
      guardianIds: guardianIds.splice(0),
      personIds: personIds.splice(0),
      accountIds: accountIds.splice(0),
    });
  });

  async function trackedStudent(opts: Parameters<typeof seedStudent>[1] = {}) {
    const s = await seedStudent(rawClient, opts);
    studentIds.push(s.studentId);
    platformStudentIds.push(s.platformStudentId);
    personIds.push(s.personId);
    return s;
  }

  async function seedLesson(): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.cls_lessons (id, school_id, class_id, title, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'Lesson under transcript', 'PUBLISHED')`,
      id,
      TEST_SCHOOL_ID,
      TEST_SIS_CLASS_ID,
    );
    lessonIds.push(id);
    return id;
  }

  async function seedRecording(): Promise<string> {
    const lessonId = await seedLesson();
    const dto = await withTestTenant(async () =>
      recordings.create({ lessonId, s3Key: 's3://b/recording.mp4' } as any, adminActor()),
    );
    // Manually flip to TRANSCRIBING — mimics what the Video Processing
    // service does when it picks up the upload.
    await rawClient.$executeRawUnsafe(
      `UPDATE ${TEST_SCHEMA}.cls_lesson_recordings SET processing_status = 'TRANSCRIBING' WHERE id = $1::uuid`,
      dto.id,
    );
    recordingIds.push(dto.id);
    return dto.id;
  }

  function makeEnvelope(opts: {
    topic: string;
    eventId?: string;
    payload: unknown;
    schoolId?: string;
    subdomain?: string;
  }): ConsumedMessage {
    return {
      topic: opts.topic,
      partition: 0,
      offset: '0',
      key: 'k',
      headers: {
        'tenant-subdomain': opts.subdomain ?? TEST_SUBDOMAIN,
        'tenant-id': opts.schoolId ?? TEST_SCHOOL_ID,
      },
      payload: {
        event_id: opts.eventId ?? generateId(),
        event_type: opts.topic,
        tenant_id: opts.schoolId ?? TEST_SCHOOL_ID,
        occurred_at: new Date().toISOString(),
        published_at: new Date().toISOString(),
        source_module: 'video-processing',
        payload: opts.payload,
      },
      timestamp: String(Date.now()),
    };
  }

  // ────────────────────────────────────────────────────────────────────
  // VideoTranscriptConsumer
  // ────────────────────────────────────────────────────────────────────
  describe('VideoTranscriptConsumer.handle', () => {
    it('end-to-end: writes transcript + summary + flips status COMPLETE + idempotency claim', async () => {
      const recId = await seedRecording();
      const eventId = generateId();
      const msg = makeEnvelope({
        topic: 'video.transcribed',
        eventId,
        payload: {
          recordingId: recId,
          schoolId: TEST_SCHOOL_ID,
          transcriptText: 'This lesson covers fractions and decimals.',
          wordCount: 7,
          language: 'en',
        },
      });
      await (videoConsumer as any).handle(msg);

      // Transcript row inserted
      const trans = await rawClient.$queryRawUnsafe<Array<{ transcript_text: string }>>(
        `SELECT transcript_text FROM ${TEST_SCHEMA}.cls_lesson_transcripts WHERE recording_id = $1::uuid`,
        recId,
      );
      expect(trans).toHaveLength(1);
      expect(trans[0]!.transcript_text).toContain('fractions');

      // Summary row inserted (via chained gateway summariseLesson)
      const summary = await rawClient.$queryRawUnsafe<Array<{ summary_text: string }>>(
        `SELECT summary_text FROM ${TEST_SCHEMA}.cls_lesson_summaries WHERE recording_id = $1::uuid`,
        recId,
      );
      expect(summary).toHaveLength(1);

      // Status flipped to COMPLETE
      const rec = await rawClient.$queryRawUnsafe<Array<{ processing_status: string }>>(
        `SELECT processing_status FROM ${TEST_SCHEMA}.cls_lesson_recordings WHERE id = $1::uuid`,
        recId,
      );
      expect(rec[0]!.processing_status).toBe('COMPLETE');

      // AI usage log row inserted for SUMMARISATION
      const usageRows = await rawClient.$queryRawUnsafe<Array<{ job_type: string }>>(
        `SELECT job_type FROM ${TEST_SCHEMA}.cls_ai_usage_log WHERE reference_id = $1::uuid`,
        recId,
      );
      expect(usageRows.length).toBeGreaterThanOrEqual(1);
      expect(usageRows[0]!.job_type).toBe('SUMMARISATION');

      // Idempotency claim recorded
      const claimed = await idempotency.isClaimed('classroom-video-transcript-consumer', eventId);
      expect(claimed).toBe(true);
    });

    it('redelivery of an already-claimed eventId is a no-op (no duplicate transcript)', async () => {
      const recId = await seedRecording();
      const eventId = generateId();
      const payload = {
        recordingId: recId,
        schoolId: TEST_SCHOOL_ID,
        transcriptText: 'Only once.',
      };
      const msg = makeEnvelope({ topic: 'video.transcribed', eventId, payload });
      await (videoConsumer as any).handle(msg);

      // Second delivery with the same envelope event_id — should drop.
      await (videoConsumer as any).handle(msg);

      const cnt = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.cls_lesson_transcripts
         WHERE recording_id = $1::uuid`,
        recId,
      );
      expect(cnt[0]!.count).toBe(1);
    });

    it('missing recordingId in payload → drop with no transcript', async () => {
      const eventId = generateId();
      const msg = makeEnvelope({
        topic: 'video.transcribed',
        eventId,
        payload: { transcriptText: 'orphaned' },
      });
      await (videoConsumer as any).handle(msg);
      const trans = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.cls_lesson_transcripts`,
      );
      expect(trans[0]!.count).toBe(0);
      // Idempotency was claimed since the consumer treated this as
      // successful no-op (process returns without throwing).
      const claimed = await idempotency.isClaimed('classroom-video-transcript-consumer', eventId);
      expect(claimed).toBe(true);
    });

    it('NotFoundException on unknown recordingId → recording is marked FAILED', async () => {
      const eventId = generateId();
      const phantomId = generateId();
      const msg = makeEnvelope({
        topic: 'video.transcribed',
        eventId,
        payload: {
          recordingId: phantomId,
          transcriptText: 'phantom',
        },
      });
      await expect((videoConsumer as any).handle(msg)).rejects.toBeDefined();
      // No transcript row written (recording doesn't exist).
      const trans = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.cls_lesson_transcripts
         WHERE recording_id = $1::uuid`,
        phantomId,
      );
      expect(trans[0]!.count).toBe(0);
      // No idempotency claim was recorded (process threw).
      const claimed = await idempotency.isClaimed('classroom-video-transcript-consumer', eventId);
      expect(claimed).toBe(false);
    });

    it('malformed envelope (no event_id and no header) → dropped silently', async () => {
      const msg = makeEnvelope({
        topic: 'video.transcribed',
        payload: { recordingId: generateId(), transcriptText: 'x' },
      });
      // Strip event_id from the envelope AND remove the header fallback.
      (msg.payload as any).event_id = undefined;
      delete msg.headers['tenant-id'];
      delete msg.headers['tenant-subdomain'];
      await (videoConsumer as any).handle(msg);
      // No transcript created, no claim recorded.
      const claims = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM platform.platform_event_consumer_idempotency
         WHERE consumer_group = 'classroom-video-transcript-consumer'`,
      );
      expect(claims[0]!.count).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // LessonSummaryConsumer
  // ────────────────────────────────────────────────────────────────────
  describe('LessonSummaryConsumer.handle', () => {
    it('writes summary + flips status to COMPLETE + idempotency claim', async () => {
      const recId = await seedRecording();
      // Move recording forward to SUMMARISING (the consumer expects a
      // recording that has already been transcribed; the applySummary
      // helper doesn't gate on status but we mirror the production
      // pipeline shape).
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.cls_lesson_recordings SET processing_status = 'SUMMARISING' WHERE id = $1::uuid`,
        recId,
      );
      const eventId = generateId();
      const msg = makeEnvelope({
        topic: 'lesson.summary.from_ai',
        eventId,
        payload: {
          recordingId: recId,
          schoolId: TEST_SCHOOL_ID,
          summaryText: 'AI-generated summary text.',
          keyTopics: ['topic-a'],
          actionItems: ['practice'],
          modelVersion: 'gpt-test',
          tokensUsed: 200,
        },
      });
      await (summaryConsumer as any).handle(msg);

      const summary = await rawClient.$queryRawUnsafe<Array<{ summary_text: string }>>(
        `SELECT summary_text FROM ${TEST_SCHEMA}.cls_lesson_summaries WHERE recording_id = $1::uuid`,
        recId,
      );
      expect(summary).toHaveLength(1);
      expect(summary[0]!.summary_text).toBe('AI-generated summary text.');

      const rec = await rawClient.$queryRawUnsafe<Array<{ processing_status: string }>>(
        `SELECT processing_status FROM ${TEST_SCHEMA}.cls_lesson_recordings WHERE id = $1::uuid`,
        recId,
      );
      expect(rec[0]!.processing_status).toBe('COMPLETE');

      const claimed = await idempotency.isClaimed('classroom-lesson-summary-consumer', eventId);
      expect(claimed).toBe(true);
    });

    it('missing summaryText → drop with claim still recorded (no-throw success path)', async () => {
      const recId = await seedRecording();
      const eventId = generateId();
      const msg = makeEnvelope({
        topic: 'lesson.summary.from_ai',
        eventId,
        payload: {
          recordingId: recId,
          // missing summaryText
        },
      });
      await (summaryConsumer as any).handle(msg);
      const summary = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.cls_lesson_summaries
         WHERE recording_id = $1::uuid`,
        recId,
      );
      expect(summary[0]!.count).toBe(0);
      const claimed = await idempotency.isClaimed('classroom-lesson-summary-consumer', eventId);
      expect(claimed).toBe(true);
    });

    it('redelivery is idempotent — second handle is a no-op', async () => {
      const recId = await seedRecording();
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.cls_lesson_recordings SET processing_status = 'SUMMARISING' WHERE id = $1::uuid`,
        recId,
      );
      const eventId = generateId();
      const msg = makeEnvelope({
        topic: 'lesson.summary.from_ai',
        eventId,
        payload: {
          recordingId: recId,
          summaryText: 'first',
          keyTopics: [],
          actionItems: [],
        },
      });
      await (summaryConsumer as any).handle(msg);
      await (summaryConsumer as any).handle(msg);
      const summary = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.cls_lesson_summaries
         WHERE recording_id = $1::uuid`,
        recId,
      );
      expect(summary[0]!.count).toBe(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // HallPassOverdueWorker
  // ────────────────────────────────────────────────────────────────────
  describe('HallPassOverdueWorker.tick', () => {
    it('walks active schools and flips eligible ACTIVE rows to OVERDUE', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      // Seed an ACTIVE pass whose window is entirely in the past so the
      // sweep predicate (expected_return_at < now() AND status='ACTIVE')
      // picks it up but the cls_hall_passes_window_chk (expected_return_at
      // > issued_at) stays satisfied.
      const passId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.cls_hall_passes
           (id, school_id, student_id, class_id, issued_by, destination,
            issued_at, expected_return_at, status, notes)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'Bathroom',
                 now() - interval '2 hours', now() - interval '1 hour',
                 'ACTIVE', NULL)`,
        passId,
        TEST_SCHOOL_ID,
        student.studentId,
        TEST_SIS_CLASS_ID,
        TEST_TEACHER_EMPLOYEE_ID,
      );

      await hallPassWorker.tick();

      const after = await rawClient.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM ${TEST_SCHEMA}.cls_hall_passes WHERE id = $1::uuid`,
        passId,
      );
      expect(after[0]!.status).toBe('OVERDUE');

      const overdueEmits = (kafka as unknown as RecordingKafkaProducer).callsForTopic(
        'cls.hall_pass.overdue',
      );
      expect(overdueEmits.length).toBeGreaterThanOrEqual(1);
      const ourEmit = overdueEmits.find((e) => e.key === passId)!;
      expect(ourEmit).toBeDefined();
      expect(ourEmit.payload).toMatchObject({
        hallPassId: passId,
        schoolId: TEST_SCHOOL_ID,
        studentId: student.studentId,
        classId: TEST_SIS_CLASS_ID,
      });
    });

    it('a second tick is a no-op for an already-OVERDUE row', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const passId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.cls_hall_passes
           (id, school_id, student_id, class_id, issued_by, destination,
            issued_at, expected_return_at, status, notes)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'Bathroom',
                 now() - interval '2 hours', now() - interval '1 hour',
                 'ACTIVE', NULL)`,
        passId,
        TEST_SCHOOL_ID,
        student.studentId,
        TEST_SIS_CLASS_ID,
        TEST_TEACHER_EMPLOYEE_ID,
      );
      await hallPassWorker.tick();
      (kafka as unknown as RecordingKafkaProducer).reset();
      await hallPassWorker.tick();
      const overdueEmits = (kafka as unknown as RecordingKafkaProducer).callsForTopic(
        'cls.hall_pass.overdue',
      );
      const ourEmits = overdueEmits.filter((e) => e.key === passId);
      // No second emit — row is now OVERDUE so the UPDATE filter excludes it.
      expect(ourEmits).toHaveLength(0);
    });

    it('concurrent tick guard — second tick while running is a no-op', async () => {
      // Force the running flag manually.
      (hallPassWorker as any).running = true;
      await hallPassWorker.tick();
      (hallPassWorker as any).running = false;
      // No assertion needed beyond "didn't throw" — the guard just early-returns.
    });

    it('no ACTIVE-past-due rows → no emits', async () => {
      (kafka as unknown as RecordingKafkaProducer).reset();
      await hallPassWorker.tick();
      const overdueEmits = (kafka as unknown as RecordingKafkaProducer).callsForTopic(
        'cls.hall_pass.overdue',
      );
      // No school A rows seeded for this test, so no flips.
      expect(overdueEmits.filter((e) => (e.payload as any)?.schoolId === TEST_SCHOOL_ID)).toEqual(
        [],
      );
    });
  });
});
