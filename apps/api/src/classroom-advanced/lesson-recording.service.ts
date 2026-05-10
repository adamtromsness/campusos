import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { OutboxService } from '../kafka/outbox.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  CreateLessonRecordingDto,
  LessonRecordingResponseDto,
  LessonSummaryResponseDto,
  LessonTranscriptResponseDto,
} from './dto/ai-tutoring.dto';

/**
 * REVIEW-P2C7 BLOCKING 3 — deterministic event IDs for the durable
 * video pipeline emits. Mirrors the P2-4a payroll, P2-6 credit-note,
 * and P2-6 reversal helpers — sha1(<recordingId>:<topic>:v1) shaped
 * as a v5-style UUID so a redelivery / retry produces the exact same
 * event_id and downstream consumer idempotency catches the dup
 * cleanly.
 */
function deterministicEventId(recordingId: string, topic: string): string {
  const hash = createHash('sha1')
    .update(recordingId + ':' + topic + ':v1')
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20)
  );
}

export function deterministicVideoUploadedEventId(recordingId: string): string {
  return deterministicEventId(recordingId, 'video.uploaded');
}

export function deterministicLessonSummaryReadyEventId(recordingId: string): string {
  return deterministicEventId(recordingId, 'lesson.summary.ready');
}

interface RecordingRow {
  id: string;
  lesson_id: string;
  class_id: string;
  school_id: string;
  recorded_by: string;
  recorded_by_name: string | null;
  s3_key: string;
  duration_seconds: number | null;
  recorded_at: Date | string;
  processing_status: 'UPLOADED' | 'TRANSCRIBING' | 'SUMMARISING' | 'COMPLETE' | 'FAILED';
  error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface TranscriptRow {
  id: string;
  recording_id: string;
  transcript_text: string;
  word_count: number | null;
  language: string;
  generated_at: Date | string;
}

interface SummaryRow {
  id: string;
  recording_id: string;
  summary_text: string;
  key_topics: string[];
  action_items: string[];
  model_version: string | null;
  tokens_used: number | null;
  generated_at: Date | string;
}

function toIso(v: Date | string | null): string {
  if (v === null) return '';
  return typeof v === 'string' ? v : v.toISOString();
}

const SELECT_RECORDING_BASE =
  'SELECT r.id, r.lesson_id::text AS lesson_id, r.class_id::text AS class_id, ' +
  'r.school_id::text AS school_id, r.recorded_by::text AS recorded_by, ' +
  "(ip.first_name || ' ' || ip.last_name) AS recorded_by_name, " +
  'r.s3_key, r.duration_seconds, r.recorded_at, r.processing_status, r.error_message, ' +
  'r.created_at, r.updated_at ' +
  'FROM cls_lesson_recordings r ' +
  'LEFT JOIN hr_employees he ON he.id = r.recorded_by ' +
  'LEFT JOIN platform.iam_person ip ON ip.id = he.person_id ';

@Injectable()
export class LessonRecordingService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly outbox: OutboxService,
  ) {}

  /** POST /classroom/lessons/:lessonId/recordings — teacher uploads (S3 key already obtained). */
  async create(
    input: CreateLessonRecordingDto,
    actor: ResolvedActor,
  ): Promise<LessonRecordingResponseDto> {
    if (!actor.employeeId) {
      throw new ForbiddenException(
        'Only employees can create lesson recordings. The calling user has no hr_employees record.',
      );
    }
    const tenant = getCurrentTenant();
    // Validate lesson + verify caller teaches it (admin bypass)
    const lessonRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ id: string; class_id: string }>>(
        'SELECT id::text AS id, class_id::text AS class_id FROM cls_lessons WHERE id = $1::uuid',
        input.lessonId,
      );
    });
    if (lessonRows.length === 0) {
      throw new NotFoundException('Lesson ' + input.lessonId + ' not found');
    }
    const classId = lessonRows[0]!.class_id;
    if (!actor.isSchoolAdmin) {
      const teaches = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_class_teachers WHERE class_id = $1::uuid AND teacher_employee_id = $2::uuid',
          classId,
          actor.employeeId,
        );
      });
      if (teaches.length === 0) {
        throw new ForbiddenException(
          'You are not assigned to the class for lesson ' + input.lessonId + '.',
        );
      }
    }
    const id = generateId();
    // REVIEW-P2C7 BLOCKING 4 — durable outbox. The recording INSERT and
    // the video.uploaded event enqueue commit together so a Kafka
    // outage cannot lose the upload event. The OutboxPublisherWorker
    // polls + publishes durably with the deterministic event_id so a
    // redelivery resolves cleanly through the consumer's idempotency.
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO cls_lesson_recordings ' +
          '(id, lesson_id, class_id, school_id, recorded_by, s3_key, duration_seconds) VALUES ' +
          '($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::int)',
        id,
        input.lessonId,
        classId,
        tenant.schoolId,
        actor.employeeId,
        input.s3Key,
        input.durationSeconds ?? null,
      );
      await this.outbox.enqueueInTx(tx, {
        topic: 'video.uploaded',
        key: id,
        sourceModule: 'classroom',
        eventId: deterministicVideoUploadedEventId(id),
        payload: {
          recordingId: id,
          sourceRefId: id,
          schoolId: tenant.schoolId,
          lessonId: input.lessonId,
          classId,
          s3Key: input.s3Key,
          durationSeconds: input.durationSeconds ?? null,
          recordedBy: actor.employeeId,
        },
      });
    });

    return this.getById(id, actor);
  }

  /** GET /classroom/recordings/:id — recording with transcript + summary inlined. */
  async getById(id: string, actor: ResolvedActor): Promise<LessonRecordingResponseDto> {
    // REVIEW-P2C7 MAJOR 7 — school-scoped query predicate so a leaked
    // recording UUID from another tenant collapses to 404 don't-leak-
    // existence at the query level (defence-in-depth alongside the
    // service-layer assertCanRead row scope).
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<RecordingRow[]>(
        SELECT_RECORDING_BASE + ' WHERE r.id = $1::uuid AND r.school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Recording ' + id + ' not found');
    const row = rows[0]!;
    await this.assertCanRead(row, actor);
    const transcript = await this.loadTranscript(id);
    const summary = await this.loadSummary(id);
    return {
      id: row.id,
      lessonId: row.lesson_id,
      classId: row.class_id,
      schoolId: row.school_id,
      recordedBy: row.recorded_by,
      recordedByName: row.recorded_by_name,
      s3Key: row.s3_key,
      durationSeconds: row.duration_seconds,
      recordedAt: toIso(row.recorded_at),
      processingStatus: row.processing_status,
      errorMessage: row.error_message,
      transcript,
      summary,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  /** GET /classroom/lessons/:lessonId/recordings — list per lesson. */
  async listForLesson(
    lessonId: string,
    actor: ResolvedActor,
  ): Promise<LessonRecordingResponseDto[]> {
    // REVIEW-P2C7 MAJOR 7 — school-scoped query predicate.
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<RecordingRow[]>(
        SELECT_RECORDING_BASE +
          ' WHERE r.lesson_id = $1::uuid AND r.school_id = $2::uuid ORDER BY r.recorded_at DESC',
        lessonId,
        tenant.schoolId,
      );
    });
    const out: LessonRecordingResponseDto[] = [];
    for (const row of rows) {
      try {
        await this.assertCanRead(row, actor);
      } catch {
        continue;
      }
      const transcript = await this.loadTranscript(row.id);
      const summary = await this.loadSummary(row.id);
      out.push({
        id: row.id,
        lessonId: row.lesson_id,
        classId: row.class_id,
        schoolId: row.school_id,
        recordedBy: row.recorded_by,
        recordedByName: row.recorded_by_name,
        s3Key: row.s3_key,
        durationSeconds: row.duration_seconds,
        recordedAt: toIso(row.recorded_at),
        processingStatus: row.processing_status,
        errorMessage: row.error_message,
        transcript,
        summary,
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
      });
    }
    return out;
  }

  /**
   * Internal — called by the VideoTranscriptConsumer when the Video
   * Processing service publishes video.transcribed. Writes the
   * transcript row + flips processing_status from TRANSCRIBING to
   * SUMMARISING in one tx.
   */
  async applyTranscript(input: {
    recordingId: string;
    transcriptText: string;
    wordCount?: number;
    language?: string;
  }): Promise<void> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<{ status: string }>>(
        'SELECT processing_status AS status FROM cls_lesson_recordings WHERE id = $1::uuid FOR UPDATE',
        input.recordingId,
      );
      if (rows.length === 0) {
        throw new NotFoundException('Recording ' + input.recordingId + ' not found');
      }
      // Idempotent — if a transcript already exists, skip
      const existing = await tx.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM cls_lesson_transcripts WHERE recording_id = $1::uuid',
        input.recordingId,
      );
      if (existing.length > 0) {
        return;
      }
      await tx.$executeRawUnsafe(
        'INSERT INTO cls_lesson_transcripts (id, recording_id, transcript_text, word_count, language) VALUES ' +
          '($1::uuid, $2::uuid, $3, $4::int, $5)',
        generateId(),
        input.recordingId,
        input.transcriptText,
        input.wordCount ?? null,
        input.language ?? 'en',
      );
      await tx.$executeRawUnsafe(
        "UPDATE cls_lesson_recordings SET processing_status = 'SUMMARISING', updated_at = now() WHERE id = $1::uuid",
        input.recordingId,
      );
    });
  }

  /**
   * Internal — called by the LessonSummaryConsumer when the AI Inference
   * service publishes lesson.summary.ready. Writes the summary row +
   * flips processing_status from SUMMARISING to COMPLETE in one tx.
   */
  async applySummary(input: {
    recordingId: string;
    summaryText: string;
    keyTopics: string[];
    actionItems: string[];
    modelVersion?: string | null;
    tokensUsed?: number | null;
  }): Promise<void> {
    // REVIEW-P2C7 BLOCKING 4 — durable outbox. The summary INSERT, the
    // recording.status flip to COMPLETE, and the lesson.summary.ready
    // outbox row commit together so teacher notification fan-out can
    // never be silently dropped on a Kafka outage. Idempotent — when
    // the summary row already exists the helper short-circuits without
    // re-enqueuing.
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<
        Array<{
          status: string;
          school_id: string;
          lesson_id: string;
          class_id: string;
          recorded_by: string;
        }>
      >(
        'SELECT processing_status AS status, school_id::text AS school_id, ' +
          'lesson_id::text AS lesson_id, class_id::text AS class_id, recorded_by::text AS recorded_by ' +
          'FROM cls_lesson_recordings WHERE id = $1::uuid FOR UPDATE',
        input.recordingId,
      );
      if (rows.length === 0) {
        throw new NotFoundException('Recording ' + input.recordingId + ' not found');
      }
      const existing = await tx.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM cls_lesson_summaries WHERE recording_id = $1::uuid',
        input.recordingId,
      );
      if (existing.length > 0) {
        return;
      }
      await tx.$executeRawUnsafe(
        'INSERT INTO cls_lesson_summaries ' +
          '(id, recording_id, summary_text, key_topics, action_items, model_version, tokens_used) VALUES ' +
          '($1::uuid, $2::uuid, $3, $4::text[], $5::text[], $6, $7::int)',
        generateId(),
        input.recordingId,
        input.summaryText,
        input.keyTopics,
        input.actionItems,
        input.modelVersion ?? null,
        input.tokensUsed ?? null,
      );
      await tx.$executeRawUnsafe(
        "UPDATE cls_lesson_recordings SET processing_status = 'COMPLETE', updated_at = now() WHERE id = $1::uuid",
        input.recordingId,
      );
      const recording = rows[0]!;
      await this.outbox.enqueueInTx(tx, {
        topic: 'lesson.summary.ready',
        key: input.recordingId,
        sourceModule: 'classroom',
        eventId: deterministicLessonSummaryReadyEventId(input.recordingId),
        payload: {
          recordingId: input.recordingId,
          sourceRefId: input.recordingId,
          schoolId: recording.school_id,
          lessonId: recording.lesson_id,
          classId: recording.class_id,
          recordedBy: recording.recorded_by,
          summaryText: input.summaryText,
          keyTopics: input.keyTopics,
          actionItems: input.actionItems,
        },
      });
    });
  }

  /**
   * Internal — flip the recording to FAILED with an error message. Used
   * by the consumers when the upstream service rejects the job.
   */
  async markFailed(recordingId: string, errorMessage: string): Promise<void> {
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        "UPDATE cls_lesson_recordings SET processing_status = 'FAILED', error_message = $2, updated_at = now() WHERE id = $1::uuid",
        recordingId,
        errorMessage,
      );
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private async loadTranscript(recordingId: string): Promise<LessonTranscriptResponseDto | null> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<TranscriptRow[]>(
        'SELECT id::text AS id, recording_id::text AS recording_id, transcript_text, ' +
          'word_count, language, generated_at FROM cls_lesson_transcripts WHERE recording_id = $1::uuid',
        recordingId,
      );
    });
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      id: r.id,
      recordingId: r.recording_id,
      transcriptText: r.transcript_text,
      wordCount: r.word_count,
      language: r.language,
      generatedAt: toIso(r.generated_at),
    };
  }

  private async loadSummary(recordingId: string): Promise<LessonSummaryResponseDto | null> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<SummaryRow[]>(
        'SELECT id::text AS id, recording_id::text AS recording_id, summary_text, ' +
          'key_topics, action_items, model_version, tokens_used, generated_at ' +
          'FROM cls_lesson_summaries WHERE recording_id = $1::uuid',
        recordingId,
      );
    });
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      id: r.id,
      recordingId: r.recording_id,
      summaryText: r.summary_text,
      keyTopics: r.key_topics ?? [],
      actionItems: r.action_items ?? [],
      modelVersion: r.model_version,
      tokensUsed: r.tokens_used,
      generatedAt: toIso(r.generated_at),
    };
  }

  private async assertCanRead(row: RecordingRow, actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STAFF' && actor.employeeId) {
      const teaches = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_class_teachers WHERE class_id = $1::uuid AND teacher_employee_id = $2::uuid',
          row.class_id,
          actor.employeeId,
        );
      });
      if (teaches.length > 0) return;
    }
    if (actor.personType === 'STUDENT') {
      const enrolled = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_enrollments e ' +
            'JOIN sis_students s ON s.id = e.student_id ' +
            'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
            "WHERE e.class_id = $1::uuid AND e.status = 'ACTIVE' AND ps.person_id = $2::uuid LIMIT 1",
          row.class_id,
          actor.personId,
        );
      });
      if (enrolled.length > 0) return;
    }
    throw new NotFoundException('Recording ' + row.id + ' not found');
  }
}
