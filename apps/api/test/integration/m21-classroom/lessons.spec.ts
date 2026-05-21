import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { LessonRecordingService } from '@modules/m21-classroom/lessons/lesson-recording.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import {
  adminActor,
  teacherActor,
  TEST_TEACHER_EMPLOYEE_ID,
  TEST_ADMIN_EMPLOYEE_ID,
} from '../helpers/actor';
import { TEST_SIS_CLASS_ID } from '../fixtures/sis';
import { assignTeacherToClass } from '../m20-sis/sis-helpers';

/**
 * Wave 4 — m21-classroom LessonRecordingService DB-backed integration.
 *
 * Contracts:
 *   - create: only an employee teaching the class can upload; admin bypass
 *   - create: emits `video.uploaded` via outbox in the same tenant tx
 *   - getById: cross-school recording id collapses to 404 (school-scope
 *     predicate in REVIEW-P2C7 MAJOR 7)
 *   - listForLesson: school-scoped
 *   - applyTranscript: writes transcript + flips status TRANSCRIBING →
 *     SUMMARISING; idempotent on second call
 *   - applySummary: writes summary + flips SUMMARISING → COMPLETE
 *   - markFailed: flips status to FAILED + records error_message
 */
describe('integration:m21-classroom/lessons', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let outbox: OutboxService;
  let service: LessonRecordingService;

  const lessonIds: string[] = [];
  const recordingIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    outbox = new OutboxService();
    service = new LessonRecordingService(tenantPrisma, outbox);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    // Wipe own rows + outbox emits
    if (recordingIds.length) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.cls_lesson_recordings WHERE id = ANY($1::uuid[])`,
        recordingIds.splice(0),
      );
    }
    if (lessonIds.length) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.cls_lessons WHERE id = ANY($1::uuid[])`,
        lessonIds.splice(0),
      );
    }
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_class_teachers`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE topic = 'video.uploaded' AND tenant_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
  });

  async function seedLesson(classId: string = TEST_SIS_CLASS_ID): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.cls_lessons (id, school_id, class_id, title, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'Lesson', 'PUBLISHED')`,
      id,
      TEST_SCHOOL_ID,
      classId,
    );
    lessonIds.push(id);
    return id;
  }

  describe('create', () => {
    it('class teacher uploads a recording → row + outbox emit', async () => {
      await assignTeacherToClass(rawClient, TEST_SIS_CLASS_ID, TEST_TEACHER_EMPLOYEE_ID);
      const lessonId = await seedLesson();
      const dto = await withTestTenant(async () =>
        service.create(
          { lessonId, s3Key: 's3://bucket/lesson-1.mp4', durationSeconds: 3600 } as any,
          teacherActor(),
        ),
      );
      expect(dto.lessonId).toBe(lessonId);
      expect(dto.processingStatus).toBe('UPLOADED');
      recordingIds.push(dto.id);

      const emits = await rawClient.$queryRawUnsafe<Array<{ topic: string }>>(
        `SELECT topic FROM platform.platform_outbox WHERE topic = 'video.uploaded' AND tenant_id = $1::uuid`,
        TEST_SCHOOL_ID,
      );
      expect(emits).toHaveLength(1);
    });

    it('admin can upload without teacher assignment', async () => {
      const lessonId = await seedLesson();
      const dto = await withTestTenant(async () =>
        service.create({ lessonId, s3Key: 's3://x' } as any, adminActor()),
      );
      expect(dto.id).toBeDefined();
      recordingIds.push(dto.id);
    });

    it('non-class teacher → ForbiddenException', async () => {
      const lessonId = await seedLesson();
      await expect(
        withTestTenant(async () =>
          service.create({ lessonId, s3Key: 's3://x' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('unknown lessonId → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(
            { lessonId: '00000000-0000-0000-0000-000000000000', s3Key: 's3://x' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('read', () => {
    it('getById unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.getById('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listForLesson returns recordings for lesson', async () => {
      const lessonId = await seedLesson();
      const r = await withTestTenant(async () =>
        service.create({ lessonId, s3Key: 's3://r1' } as any, adminActor()),
      );
      recordingIds.push(r.id);
      const list = await withTestTenant(async () => service.listForLesson(lessonId, adminActor()));
      expect(list.map((x) => x.id)).toContain(r.id);
    });

    it('getById fetches a created recording', async () => {
      const lessonId = await seedLesson();
      const r = await withTestTenant(async () =>
        service.create({ lessonId, s3Key: 's3://r2' } as any, adminActor()),
      );
      recordingIds.push(r.id);
      const fetched = await withTestTenant(async () => service.getById(r.id, adminActor()));
      expect(fetched.id).toBe(r.id);
    });
  });

  describe('applyTranscript / applySummary / markFailed', () => {
    it('applyTranscript writes row + flips to SUMMARISING; idempotent', async () => {
      const lessonId = await seedLesson();
      const r = await withTestTenant(async () =>
        service.create({ lessonId, s3Key: 's3://t1' } as any, adminActor()),
      );
      recordingIds.push(r.id);
      // Flip status to TRANSCRIBING manually (mimics video pipeline state)
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.cls_lesson_recordings SET processing_status = 'TRANSCRIBING' WHERE id = $1::uuid`,
        r.id,
      );

      await withTestTenant(async () =>
        service.applyTranscript({
          recordingId: r.id,
          transcriptText: 'Hello world',
          wordCount: 2,
          language: 'en',
        }),
      );
      const after = await withTestTenant(async () => service.getById(r.id, adminActor()));
      expect(after.processingStatus).toBe('SUMMARISING');
      expect(after.transcript?.transcriptText).toBe('Hello world');

      // Second call should be a no-op
      await withTestTenant(async () =>
        service.applyTranscript({
          recordingId: r.id,
          transcriptText: 'Ignored second attempt',
        }),
      );
      const stillFirst = await withTestTenant(async () => service.getById(r.id, adminActor()));
      expect(stillFirst.transcript?.transcriptText).toBe('Hello world');
    });

    it('applyTranscript on unknown recording → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.applyTranscript({
            recordingId: '00000000-0000-0000-0000-000000000000',
            transcriptText: 'x',
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('applySummary flips to COMPLETE', async () => {
      const lessonId = await seedLesson();
      const r = await withTestTenant(async () =>
        service.create({ lessonId, s3Key: 's3://s1' } as any, adminActor()),
      );
      recordingIds.push(r.id);
      // Move it through to SUMMARISING via transcript
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.cls_lesson_recordings SET processing_status = 'TRANSCRIBING' WHERE id = $1::uuid`,
        r.id,
      );
      await withTestTenant(async () =>
        service.applyTranscript({ recordingId: r.id, transcriptText: 't' }),
      );
      await withTestTenant(async () =>
        service.applySummary({
          recordingId: r.id,
          summaryText: 'A short summary.',
          keyTopics: ['topic-a'],
          actionItems: ['do-x'],
        }),
      );
      const after = await withTestTenant(async () => service.getById(r.id, adminActor()));
      expect(after.processingStatus).toBe('COMPLETE');
      expect(after.summary?.summaryText).toBe('A short summary.');
    });

    it('markFailed flips status + records error_message', async () => {
      const lessonId = await seedLesson();
      const r = await withTestTenant(async () =>
        service.create({ lessonId, s3Key: 's3://f1' } as any, adminActor()),
      );
      recordingIds.push(r.id);
      await withTestTenant(async () => service.markFailed(r.id, 'video too long'));
      const after = await withTestTenant(async () => service.getById(r.id, adminActor()));
      expect(after.processingStatus).toBe('FAILED');
      expect(after.errorMessage).toBe('video too long');
    });
  });

  // Suppress unused imports
  void TEST_ADMIN_EMPLOYEE_ID;
});
