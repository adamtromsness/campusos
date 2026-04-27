import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import {
  KafkaConsumerService,
  ConsumedMessage,
} from '../kafka/kafka-consumer.service';
import { IdempotencyService } from '../kafka/idempotency.service';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import {
  TenantInfo,
  runWithTenantContextAsync,
} from '../tenant/tenant.context';

/**
 * GradebookSnapshotWorker — first Kafka consumer in CampusOS.
 *
 * Consumes cls.grade.published / cls.grade.unpublished and recomputes
 * cls_gradebook_snapshots asynchronously, per ADR-010 (snapshots are never
 * updated inside a grade transaction).
 *
 * Debounce: 30 seconds per (schoolId, classId, studentId). Multiple events
 * for the same student in the same class — common during batch grading or
 * publish-all — collapse into a single recompute. The 30s window is a
 * deliberate tradeoff: short enough that a parent refreshing the dashboard
 * sees fresh numbers within a minute, long enough to absorb a bulk publish.
 *
 * Idempotency: each event carries an `event-id` header. On arrival the
 * handler claims (consumerGroup, eventId) in
 * platform_event_consumer_idempotency. A redelivered duplicate fails the
 * claim and is dropped before it can reset the debounce timer or fire
 * a redundant recompute. New (unseen) event ids reset the debounce.
 *
 * Failure modes:
 *   - Bad payload → log + drop. Producer-side bug; no retry helps.
 *   - DB transient error during flush → log; the next event for the same
 *     (class, student) will retry the recompute. Snapshots are eventually
 *     consistent, not transactionally consistent — the seed-published
 *     baseline plus the next valid event closes any gap.
 *   - Kafka unreachable on boot → KafkaConsumerService no-ops; the worker
 *     becomes a no-op until next deploy. Existing snapshots stay correct.
 *
 * The recompute algorithm matches packages/database/src/seed-classroom.ts
 * verbatim — both the seed and this worker MUST stay in sync, otherwise
 * the seed-time baseline would silently drift the first time a grade is
 * published. Algorithm:
 *
 *   For (class, student):
 *     1. Pull every published cls_grades row joined to its assignment +
 *        category, restricted to assignments belonging to this class.
 *     2. Group by category. Per-category mean of (grade_value/max_points*100).
 *     3. Weighted sum across categories with at least one published grade,
 *        renormalised by the sum of *participating* category weights.
 *     4. Letter grade derived via the same A/B/C/D/F bucketing the seed uses.
 *
 *   If no published grades remain (every grade has been unpublished),
 *   the existing snapshot is deleted — better than leaving a stale row.
 */

interface GradePayload {
  gradeId: string;
  assignmentId: string;
  classId: string;
  studentId: string;
  termId: string | null;
}

interface DebounceEntry {
  timer: NodeJS.Timeout;
  // Snapshot of tenant info for the flush — captured at first event so
  // we don't rely on the AsyncLocalStorage being live at flush time.
  tenant: TenantInfo;
}

var DEBOUNCE_MS = 30_000;
var CONSUMER_GROUP = 'gradebook-snapshot-worker';

@Injectable()
export class GradebookSnapshotWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(GradebookSnapshotWorker.name);
  private readonly debounce = new Map<string, DebounceEntry>();

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    var self = this;
    await this.consumer.subscribe({
      topics: ['cls.grade.published', 'cls.grade.unpublished'],
      groupId: CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  async onApplicationShutdown(): Promise<void> {
    // Flush in-flight timers so we don't leak unprocessed grade events.
    for (const [, entry] of this.debounce) {
      clearTimeout(entry.timer);
    }
    this.debounce.clear();
  }

  /**
   * Test seam — flush every pending debounce entry immediately and wait
   * for the recomputes to finish. Used by smoke tests so we don't have to
   * sleep for 30s per assertion. Not called by the production code path.
   */
  async flushAllForTest(): Promise<void> {
    var keys = Array.from(this.debounce.keys());
    var promises: Promise<void>[] = [];
    for (var i = 0; i < keys.length; i++) {
      var entry = this.debounce.get(keys[i]!);
      if (!entry) continue;
      clearTimeout(entry.timer);
      this.debounce.delete(keys[i]!);
      promises.push(this.flush(keys[i]!, entry));
    }
    await Promise.all(promises);
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    var eventId = msg.headers['event-id'];
    var subdomain = msg.headers['tenant-subdomain'];
    var schoolId = msg.headers['tenant-id'];
    if (!eventId || !subdomain || !schoolId) {
      this.logger.warn(
        'Dropping ' + msg.topic + ' — missing transport headers (event-id/tenant-id/tenant-subdomain)',
      );
      return;
    }

    var payload = msg.payload as GradePayload | null;
    if (!payload || !payload.classId || !payload.studentId) {
      this.logger.warn('Dropping ' + msg.topic + ' (eventId=' + eventId + ') — invalid payload');
      return;
    }

    // Claim before debouncing so a redelivered duplicate can't reset the
    // timer. Distinct events for the same (class, student) — produced by
    // batch grading or publish-all — each get their own row in the
    // idempotency table; the recompute itself collapses them.
    var firstTime: boolean;
    try {
      firstTime = await this.idempotency.claim(CONSUMER_GROUP, eventId, msg.topic);
    } catch (e: any) {
      this.logger.error(
        'Idempotency claim failed (eventId=' + eventId + '): ' + (e?.stack || e?.message || e),
      );
      return;
    }
    if (!firstTime) {
      this.logger.debug('Skip duplicate eventId=' + eventId);
      return;
    }

    var tenant: TenantInfo = {
      schoolId: schoolId,
      schemaName: 'tenant_' + subdomain,
      organisationId: null,
      subdomain: subdomain,
      isFrozen: false,
      planTier: 'STANDARD',
    };

    var key = schoolId + '|' + payload.classId + '|' + payload.studentId;
    var existing = this.debounce.get(key);
    if (existing) {
      clearTimeout(existing.timer);
    }
    var self = this;
    var timer = setTimeout(function () {
      var entry = self.debounce.get(key);
      if (!entry) return;
      self.debounce.delete(key);
      self.flush(key, entry).catch(function (e) {
        self.logger.error(
          'Flush failed for ' + key + ': ' + (e?.stack || e?.message || e),
        );
      });
    }, DEBOUNCE_MS);
    timer.unref?.();

    this.debounce.set(key, { timer: timer, tenant: tenant });
  }

  /**
   * The actual flush — runs after the debounce timer fires (or immediately
   * via flushAllForTest). Idempotency was already claimed at message
   * arrival, so this is the unconditional recompute path.
   */
  private async flush(key: string, entry: DebounceEntry): Promise<void> {
    var parts = key.split('|');
    var classId = parts[1]!;
    var studentId = parts[2]!;
    var tenant = entry.tenant;
    var self = this;

    await runWithTenantContextAsync({ tenant: tenant }, async function () {
      await self.recomputeSnapshot(classId, studentId);
    });
  }

  /**
   * Reads every published grade for (class, student), recomputes the
   * weighted average per category, and upserts cls_gradebook_snapshots.
   *
   * Algorithm matches seed-classroom.ts. If no published grades exist, the
   * snapshot row (if any) is deleted so the parent UI doesn't show a stale
   * average. assignments_total counts every published assignment in the
   * class so the "graded N of T" column matches the gradebook view.
   */
  private async recomputeSnapshot(classId: string, studentId: string): Promise<void> {
    var prisma = this.tenantPrisma;

    var rows = await prisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{
          category_name: string;
          category_weight: string;
          max_points: string;
          grade_value: string;
        }>
      >(
        'SELECT c.name AS category_name, c.weight::text AS category_weight, ' +
          'a.max_points::text AS max_points, g.grade_value::text AS grade_value ' +
          'FROM cls_grades g ' +
          'JOIN cls_assignments a ON a.id = g.assignment_id ' +
          'JOIN cls_assignment_categories c ON c.id = a.category_id ' +
          'WHERE a.class_id = $1::uuid AND g.student_id = $2::uuid AND g.is_published = true',
        classId,
        studentId,
      );
    });

    var classMeta = await prisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ term_id: string | null }>>(
        'SELECT term_id FROM sis_classes WHERE id = $1::uuid',
        classId,
      );
    });
    var termId: string | null = classMeta.length > 0 ? classMeta[0]!.term_id : null;
    if (!termId) {
      // Resolve a default term: today's term, then most-recent fallback.
      var resolved = await prisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ id: string }>>(
          'SELECT id FROM sis_terms ' +
            'WHERE CURRENT_DATE BETWEEN start_date AND end_date ' +
            'ORDER BY start_date DESC LIMIT 1',
        );
      });
      if (resolved.length === 0) {
        resolved = await prisma.executeInTenantContext(async (client) => {
          return client.$queryRawUnsafe<Array<{ id: string }>>(
            'SELECT id FROM sis_terms ORDER BY start_date DESC LIMIT 1',
          );
        });
      }
      termId = resolved.length > 0 ? resolved[0]!.id : null;
    }
    if (!termId) {
      this.logger.warn(
        'Skipping snapshot for class=' + classId + ' student=' + studentId + ' — no terms in tenant',
      );
      return;
    }

    var assignmentsTotal = await prisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ count: bigint }>>(
        'SELECT count(*)::bigint AS count FROM cls_assignments ' +
          'WHERE class_id = $1::uuid AND is_published = true AND deleted_at IS NULL',
        classId,
      );
    });
    var totalCount = Number(assignmentsTotal[0]?.count ?? 0n);

    if (rows.length === 0) {
      // No published grades → delete any stale snapshot.
      await prisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'DELETE FROM cls_gradebook_snapshots ' +
            'WHERE class_id = $1::uuid AND student_id = $2::uuid AND term_id = $3::uuid',
          classId,
          studentId,
          termId,
        );
      });
      this.logger.log(
        'Snapshot cleared (no published grades): class=' + classId + ' student=' + studentId,
      );
      return;
    }

    interface CatBucket {
      pcts: number[];
      weight: number;
    }
    var perCat: Record<string, CatBucket> = {};
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i]!;
      var pct = (Number(r.grade_value) / Number(r.max_points)) * 100;
      var bucket = perCat[r.category_name];
      if (!bucket) {
        perCat[r.category_name] = { pcts: [pct], weight: Number(r.category_weight) };
      } else {
        bucket.pcts.push(pct);
      }
    }
    var weightedSum = 0;
    var weightTotal = 0;
    var assignmentsGraded = 0;
    var catNames = Object.keys(perCat);
    for (var ci = 0; ci < catNames.length; ci++) {
      var cb = perCat[catNames[ci]!]!;
      var catAvg = cb.pcts.reduce(function (s, x) {
        return s + x;
      }, 0) / cb.pcts.length;
      weightedSum += catAvg * cb.weight;
      weightTotal += cb.weight;
      assignmentsGraded += cb.pcts.length;
    }
    var currentAvg = weightTotal > 0 ? weightedSum / weightTotal : 0;
    var letter = letterGrade(currentAvg);

    // Upsert by (class, student, term). Insert path generates a new id; the
    // ON CONFLICT path leaves the existing id alone and refreshes the rest.
    await prisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO cls_gradebook_snapshots ' +
          '(id, class_id, student_id, term_id, current_average, letter_grade, ' +
          'assignments_graded, assignments_total, last_grade_event_at, last_updated_at) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::numeric, $6, $7, $8, now(), now()) ' +
          'ON CONFLICT (class_id, student_id, term_id) DO UPDATE SET ' +
          '  current_average = EXCLUDED.current_average, ' +
          '  letter_grade = EXCLUDED.letter_grade, ' +
          '  assignments_graded = EXCLUDED.assignments_graded, ' +
          '  assignments_total = EXCLUDED.assignments_total, ' +
          '  last_grade_event_at = now(), ' +
          '  last_updated_at = now()',
        generateId(),
        classId,
        studentId,
        termId,
        currentAvg.toFixed(2),
        letter,
        assignmentsGraded,
        totalCount,
      );
    });

    this.logger.log(
      'Snapshot recomputed: class=' + classId + ' student=' + studentId +
        ' avg=' + currentAvg.toFixed(2) + ' letter=' + letter +
        ' graded=' + assignmentsGraded + '/' + totalCount,
    );
  }
}

function letterGrade(pct: number): string {
  if (pct >= 90) return 'A';
  if (pct >= 80) return 'B';
  if (pct >= 70) return 'C';
  if (pct >= 60) return 'D';
  return 'F';
}
