import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { AssignmentService } from './assignment.service';
import {
  BatchGradeRequestDto,
  BatchGradeResponseDto,
  GradeResponseDto,
  GradeSubmissionDto,
  PublishAllResponseDto,
} from './dto/grade.dto';

interface GradeRow {
  id: string;
  assignment_id: string;
  class_id: string;
  student_id: string;
  submission_id: string | null;
  teacher_id: string;
  grade_value: string;
  max_points: string;
  is_extra_credit: boolean;
  term_id: string | null;
  letter_grade: string | null;
  feedback: string | null;
  is_published: boolean;
  graded_at: Date | string;
  published_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function toIso(v: Date | string | null): string | null {
  if (v === null) return null;
  return typeof v === 'string' ? v : v.toISOString();
}

function rowToDto(r: GradeRow): GradeResponseDto {
  var max = Number(r.max_points);
  var val = Number(r.grade_value);
  var pct = max > 0 ? (val / max) * 100 : 0;
  return {
    id: r.id,
    assignmentId: r.assignment_id,
    classId: r.class_id,
    studentId: r.student_id,
    submissionId: r.submission_id,
    teacherId: r.teacher_id,
    gradeValue: val,
    maxPoints: max,
    percentage: Math.round(pct * 100) / 100,
    letterGrade: r.letter_grade,
    feedback: r.feedback,
    isPublished: r.is_published,
    gradedAt: toIso(r.graded_at) || '',
    publishedAt: toIso(r.published_at),
    createdAt: toIso(r.created_at) || '',
    updatedAt: toIso(r.updated_at) || '',
  };
}

var SELECT_GRADE_BASE =
  'SELECT g.id, g.assignment_id, a.class_id, g.student_id, g.submission_id, g.teacher_id, ' +
  'g.grade_value, a.max_points, a.is_extra_credit, c.term_id, ' +
  'g.letter_grade, g.feedback, g.is_published, g.graded_at, g.published_at, ' +
  'g.created_at, g.updated_at ' +
  'FROM cls_grades g ' +
  'JOIN cls_assignments a ON a.id = g.assignment_id ' +
  'JOIN sis_classes c ON c.id = a.class_id ';

interface AssignmentForGrading {
  id: string;
  classId: string;
  isPublished: boolean;
  isDeleted: boolean;
  maxPoints: number;
  isExtraCredit: boolean;
  termId: string | null;
}

/**
 * Default letter buckets when no scale is configured. Matches the seed and
 * the grading_scales row "Standard A-F (Percentage)" in seed-classroom.
 */
function deriveLetter(pct: number): string {
  if (pct >= 90) return 'A';
  if (pct >= 80) return 'B';
  if (pct >= 70) return 'C';
  if (pct >= 60) return 'D';
  return 'F';
}

@Injectable()
export class GradeService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly assignments: AssignmentService,
    private readonly kafka: KafkaProducerService,
  ) {}

  private async loadAssignmentForGrading(assignmentId: string): Promise<AssignmentForGrading> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{
          id: string;
          class_id: string;
          is_published: boolean;
          deleted_at: Date | null;
          max_points: string;
          is_extra_credit: boolean;
          term_id: string | null;
        }>
      >(
        'SELECT a.id, a.class_id, a.is_published, a.deleted_at, a.max_points, a.is_extra_credit, ' +
          'c.term_id ' +
          'FROM cls_assignments a ' +
          'JOIN sis_classes c ON c.id = a.class_id ' +
          'WHERE a.id = $1::uuid',
        assignmentId,
      );
    });
    if (rows.length === 0) {
      throw new NotFoundException('Assignment ' + assignmentId + ' not found');
    }
    var r = rows[0]!;
    return {
      id: r.id,
      classId: r.class_id,
      isPublished: r.is_published,
      isDeleted: r.deleted_at !== null,
      maxPoints: Number(r.max_points),
      isExtraCredit: r.is_extra_credit,
      termId: r.term_id,
    };
  }

  /**
   * Grade a single submission. The route is /submissions/:id/grade — we
   * look up the submission to recover (assignment_id, student_id) before
   * delegating to the upsert helper.
   */
  async gradeSubmission(
    submissionId: string,
    body: GradeSubmissionDto,
    actor: ResolvedActor,
  ): Promise<GradeResponseDto> {
    var subRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{ id: string; assignment_id: string; student_id: string }>
      >(
        'SELECT id, assignment_id, student_id FROM cls_submissions WHERE id = $1::uuid',
        submissionId,
      );
    });
    if (subRows.length === 0) {
      throw new NotFoundException('Submission ' + submissionId + ' not found');
    }
    var sub = subRows[0]!;
    var meta = await this.loadAssignmentForGrading(sub.assignment_id);
    if (meta.isDeleted)
      throw new NotFoundException('Assignment ' + sub.assignment_id + ' not found');
    await this.assignments.assertCanWriteClass(meta.classId, actor);
    if (body.gradeValue > meta.maxPoints && !meta.isExtraCredit) {
      throw new BadRequestException(
        'gradeValue ' + body.gradeValue + ' exceeds max_points ' + meta.maxPoints,
      );
    }

    var gradeId = await this.upsertGrade(
      meta,
      sub.student_id,
      body.gradeValue,
      body.letterGrade,
      body.feedback,
      sub.id,
      body.publish === true,
      actor,
    );
    return this.getById(gradeId);
  }

  /**
   * Batch grade an assignment in one transaction. Each entry creates or
   * updates the cls_grades row for that (assignment, student) and (when
   * a matching submission exists) flips the submission to GRADED.
   *
   * Per-row Kafka emits happen after the transaction commits — never
   * inside the tx, so a Kafka outage doesn't roll back persistence.
   */
  async batchGrade(
    classId: string,
    body: BatchGradeRequestDto,
    actor: ResolvedActor,
  ): Promise<BatchGradeResponseDto> {
    await this.assignments.assertCanWriteClass(classId, actor);
    var meta = await this.loadAssignmentForGrading(body.assignmentId);
    if (meta.isDeleted) {
      throw new NotFoundException('Assignment ' + body.assignmentId + ' not found');
    }
    if (meta.classId !== classId) {
      throw new BadRequestException(
        'Assignment ' + body.assignmentId + ' does not belong to class ' + classId,
      );
    }

    // Validate every entry's gradeValue up front so the tx doesn't half-apply.
    for (var ei = 0; ei < body.entries.length; ei++) {
      var e = body.entries[ei]!;
      if (e.gradeValue > meta.maxPoints && !meta.isExtraCredit) {
        throw new BadRequestException(
          'Entry for student ' +
            e.studentId +
            ': gradeValue ' +
            e.gradeValue +
            ' exceeds max_points ' +
            meta.maxPoints,
        );
      }
    }

    var publish = body.publish === true;
    var gradeIds: string[] = [];
    var gradeIdsToEmit: string[] = [];
    var insertedCount = 0;
    var updatedCount = 0;
    var publishedCount = 0;

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Validate every studentId is enrolled in the class — single round-trip.
      var studentIds = body.entries.map(function (en) {
        return en.studentId;
      });
      var enrolled = await tx.$queryRawUnsafe<Array<{ student_id: string }>>(
        'SELECT student_id::text AS student_id FROM sis_enrollments ' +
          "WHERE class_id = $1::uuid AND status = 'ACTIVE' AND student_id = ANY($2::uuid[])",
        classId,
        studentIds,
      );
      var enrolledSet = new Set(
        enrolled.map(function (r) {
          return r.student_id;
        }),
      );
      for (var k = 0; k < studentIds.length; k++) {
        if (!enrolledSet.has(studentIds[k]!)) {
          throw new BadRequestException(
            'Student ' + studentIds[k] + ' is not actively enrolled in class ' + classId,
          );
        }
      }

      for (var i = 0; i < body.entries.length; i++) {
        var entry = body.entries[i]!;
        // Find an existing submission row to link (optional).
        var subRows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          'SELECT id FROM cls_submissions WHERE assignment_id = $1::uuid AND student_id = $2::uuid',
          meta.id,
          entry.studentId,
        );
        var submissionIdLink: string | null = subRows.length > 0 ? subRows[0]!.id : null;

        var existingGrade = await tx.$queryRawUnsafe<Array<{ id: string; is_published: boolean }>>(
          'SELECT id, is_published FROM cls_grades WHERE assignment_id = $1::uuid AND student_id = $2::uuid',
          meta.id,
          entry.studentId,
        );
        var pct = meta.maxPoints > 0 ? (entry.gradeValue / meta.maxPoints) * 100 : 0;
        var letter = entry.letterGrade ?? deriveLetter(pct);
        var gradeId: string;
        if (existingGrade.length > 0) {
          gradeId = existingGrade[0]!.id;
          await tx.$executeRawUnsafe(
            'UPDATE cls_grades SET ' +
              'grade_value = $1::numeric, ' +
              'letter_grade = $2, ' +
              'feedback = COALESCE($3, feedback), ' +
              'submission_id = COALESCE($4::uuid, submission_id), ' +
              'teacher_id = $5::uuid, ' +
              'is_published = CASE WHEN $6 THEN true ELSE is_published END, ' +
              'published_at = CASE WHEN $6 AND published_at IS NULL THEN now() ELSE published_at END, ' +
              'graded_at = now(), ' +
              'updated_at = now() ' +
              'WHERE id = $7::uuid',
            entry.gradeValue.toFixed(2),
            letter,
            entry.feedback ?? null,
            submissionIdLink,
            actor.personId,
            publish,
            gradeId,
          );
          updatedCount++;
        } else {
          gradeId = generateId();
          await tx.$executeRawUnsafe(
            'INSERT INTO cls_grades ' +
              '(id, assignment_id, student_id, submission_id, teacher_id, grade_value, ' +
              'letter_grade, feedback, is_published, published_at) ' +
              'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::numeric, $7, $8, $9, ' +
              'CASE WHEN $9 THEN now() ELSE NULL END)',
            gradeId,
            meta.id,
            entry.studentId,
            submissionIdLink,
            actor.personId,
            entry.gradeValue.toFixed(2),
            letter,
            entry.feedback ?? null,
            publish,
          );
          insertedCount++;
        }
        if (publish) publishedCount++;
        gradeIds.push(gradeId);
        // Track which grade ids end up published so the post-commit emit
        // covers updates to already-published grades (value/feedback edits).
        if (publish || (existingGrade.length > 0 && existingGrade[0]!.is_published)) {
          gradeIdsToEmit.push(gradeId);
        }

        if (submissionIdLink !== null) {
          await tx.$executeRawUnsafe(
            "UPDATE cls_submissions SET status = 'GRADED', updated_at = now() WHERE id = $1::uuid",
            submissionIdLink,
          );
        }
      }
    });

    var grades = await this.fetchGradesByIds(gradeIds);

    if (gradeIdsToEmit.length > 0) {
      var gradesToEmit = grades.filter(function (g) {
        return gradeIdsToEmit.indexOf(g.id) >= 0;
      });
      for (var gi = 0; gi < gradesToEmit.length; gi++) {
        this.emitPublished(gradesToEmit[gi]!, meta.termId);
      }
    }

    return {
      assignmentId: meta.id,
      classId: meta.classId,
      processedCount: body.entries.length,
      insertedCount: insertedCount,
      updatedCount: updatedCount,
      publishedCount: publishedCount,
      grades: grades,
    };
  }

  /**
   * Publish a single (already-existing) grade. Idempotent: republishing a
   * published grade is a no-op except for updated_at. Emits cls.grade.published
   * only if the row transitioned from draft → published this call.
   */
  async publish(gradeId: string, actor: ResolvedActor): Promise<GradeResponseDto> {
    var existing = await this.fetchGradeById(gradeId);
    await this.assignments.assertCanWriteClass(existing.classId, actor);
    var wasUnpublished = existing.isPublished === false;
    if (wasUnpublished) {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE cls_grades SET is_published = true, published_at = now(), updated_at = now() ' +
            'WHERE id = $1::uuid',
          gradeId,
        );
      });
    }
    var refreshed = await this.fetchGradeById(gradeId);
    if (wasUnpublished) {
      var meta = await this.loadAssignmentForGrading(refreshed.assignmentId);
      this.emitPublished(refreshed, meta.termId);
    }
    return refreshed;
  }

  /**
   * Unpublish a grade — flips is_published=false and emits cls.grade.unpublished
   * so the snapshot worker reduces this student's average. Keeps published_at
   * intact so we can audit when it was last published.
   */
  async unpublish(gradeId: string, actor: ResolvedActor): Promise<GradeResponseDto> {
    var existing = await this.fetchGradeById(gradeId);
    await this.assignments.assertCanWriteClass(existing.classId, actor);
    var wasPublished = existing.isPublished === true;
    if (wasPublished) {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE cls_grades SET is_published = false, updated_at = now() WHERE id = $1::uuid',
          gradeId,
        );
      });
    }
    var refreshed = await this.fetchGradeById(gradeId);
    if (wasPublished) {
      var meta = await this.loadAssignmentForGrading(refreshed.assignmentId);
      this.emitUnpublished(refreshed, meta.termId);
    }
    return refreshed;
  }

  /**
   * Bulk publish every draft grade for an assignment. Body specifies the
   * assignment_id; the class on the URL must own it. Emits one event per
   * row that transitions from draft → published.
   */
  async publishAllForAssignment(
    classId: string,
    assignmentId: string,
    actor: ResolvedActor,
  ): Promise<PublishAllResponseDto> {
    await this.assignments.assertCanWriteClass(classId, actor);
    var meta = await this.loadAssignmentForGrading(assignmentId);
    if (meta.isDeleted) {
      throw new NotFoundException('Assignment ' + assignmentId + ' not found');
    }
    if (meta.classId !== classId) {
      throw new BadRequestException(
        'Assignment ' + assignmentId + ' does not belong to class ' + classId,
      );
    }

    var changedIds = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id FROM cls_grades WHERE assignment_id = $1::uuid AND is_published = false',
        assignmentId,
      );
      var ids = rows.map(function (r) {
        return r.id;
      });
      if (ids.length > 0) {
        await tx.$executeRawUnsafe(
          'UPDATE cls_grades SET is_published = true, ' +
            'published_at = COALESCE(published_at, now()), ' +
            'updated_at = now() ' +
            'WHERE assignment_id = $1::uuid AND is_published = false',
          assignmentId,
        );
      }
      return ids;
    });

    var grades = await this.fetchGradesByIds(changedIds);
    for (var gi = 0; gi < grades.length; gi++) {
      this.emitPublished(grades[gi]!, meta.termId);
    }
    return {
      assignmentId: assignmentId,
      classId: meta.classId,
      publishedCount: changedIds.length,
      grades: grades,
    };
  }

  /**
   * Internal helper: find or insert a cls_grades row for (assignment, student),
   * optionally publish, and bump the submission to GRADED if a link exists.
   * Emits cls.grade.published when a draft is freshly published.
   *
   * Returns the resulting grade id.
   */
  private async upsertGrade(
    meta: AssignmentForGrading,
    studentId: string,
    gradeValue: number,
    explicitLetter: string | undefined,
    feedback: string | undefined,
    submissionIdLink: string | null,
    publish: boolean,
    actor: ResolvedActor,
  ): Promise<string> {
    var pct = meta.maxPoints > 0 ? (gradeValue / meta.maxPoints) * 100 : 0;
    var letter = explicitLetter ?? deriveLetter(pct);
    var emitPublishedAfter = false;
    var resultingId = '';

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var existing = await tx.$queryRawUnsafe<Array<{ id: string; is_published: boolean }>>(
        'SELECT id, is_published FROM cls_grades WHERE assignment_id = $1::uuid AND student_id = $2::uuid',
        meta.id,
        studentId,
      );
      if (existing.length > 0) {
        var ex = existing[0]!;
        resultingId = ex.id;
        await tx.$executeRawUnsafe(
          'UPDATE cls_grades SET ' +
            'grade_value = $1::numeric, ' +
            'letter_grade = $2, ' +
            'feedback = COALESCE($3, feedback), ' +
            'submission_id = COALESCE($4::uuid, submission_id), ' +
            'teacher_id = $5::uuid, ' +
            'is_published = CASE WHEN $6 THEN true ELSE is_published END, ' +
            'published_at = CASE WHEN $6 AND published_at IS NULL THEN now() ELSE published_at END, ' +
            'graded_at = now(), ' +
            'updated_at = now() ' +
            'WHERE id = $7::uuid',
          gradeValue.toFixed(2),
          letter,
          feedback ?? null,
          submissionIdLink,
          actor.personId,
          publish,
          ex.id,
        );
        // Emit when the row is published after this update — covers both
        // "draft → published" and "value changed on already-published grade".
        // The snapshot worker is idempotent so a redundant emit is harmless,
        // but failing to emit on a value change would leave the snapshot
        // stale until another event fires.
        if (publish || ex.is_published) emitPublishedAfter = true;
      } else {
        resultingId = generateId();
        await tx.$executeRawUnsafe(
          'INSERT INTO cls_grades ' +
            '(id, assignment_id, student_id, submission_id, teacher_id, grade_value, ' +
            'letter_grade, feedback, is_published, published_at) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::numeric, $7, $8, $9, ' +
            'CASE WHEN $9 THEN now() ELSE NULL END)',
          resultingId,
          meta.id,
          studentId,
          submissionIdLink,
          actor.personId,
          gradeValue.toFixed(2),
          letter,
          feedback ?? null,
          publish,
        );
        if (publish) emitPublishedAfter = true;
      }

      if (submissionIdLink !== null) {
        await tx.$executeRawUnsafe(
          "UPDATE cls_submissions SET status = 'GRADED', updated_at = now() WHERE id = $1::uuid",
          submissionIdLink,
        );
      }
    });

    if (emitPublishedAfter) {
      var refreshed = await this.fetchGradeById(resultingId);
      this.emitPublished(refreshed, meta.termId);
    }
    return resultingId;
  }

  /**
   * Single-row read of a grade by id. 404 when missing. No row-level filter:
   * the route guards (assertCanWriteClass) gate the *operation*; this is
   * just a fetch helper for the post-write response.
   */
  async getById(gradeId: string): Promise<GradeResponseDto> {
    return this.fetchGradeById(gradeId);
  }

  private async fetchGradeById(gradeId: string): Promise<GradeResponseDto> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<GradeRow[]>(
        SELECT_GRADE_BASE + 'WHERE g.id = $1::uuid',
        gradeId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Grade ' + gradeId + ' not found');
    return rowToDto(rows[0]!);
  }

  private async fetchGradesByIds(ids: string[]): Promise<GradeResponseDto[]> {
    if (ids.length === 0) return [];
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<GradeRow[]>(
        SELECT_GRADE_BASE + 'WHERE g.id = ANY($1::uuid[]) ORDER BY g.created_at',
        ids,
      );
    });
    return rows.map(rowToDto);
  }

  private emitPublished(g: GradeResponseDto, termId: string | null): void {
    void this.kafka.emit(
      'cls.grade.published',
      g.studentId,
      {
        gradeId: g.id,
        assignmentId: g.assignmentId,
        classId: g.classId,
        studentId: g.studentId,
        gradeValue: g.gradeValue,
        maxPoints: g.maxPoints,
        letterGrade: g.letterGrade,
        isExtraCredit: false,
        termId: termId,
        publishedAt: g.publishedAt,
      },
      this.tenantHeaders(),
    );
  }

  private emitUnpublished(g: GradeResponseDto, termId: string | null): void {
    void this.kafka.emit(
      'cls.grade.unpublished',
      g.studentId,
      {
        gradeId: g.id,
        assignmentId: g.assignmentId,
        classId: g.classId,
        studentId: g.studentId,
        gradeValue: g.gradeValue,
        maxPoints: g.maxPoints,
        letterGrade: g.letterGrade,
        isExtraCredit: false,
        termId: termId,
        unpublishedAt: new Date().toISOString(),
      },
      this.tenantHeaders(),
    );
  }

  /**
   * Standard transport headers for the cls.grade.* topics. The first consumer
   * (GradebookSnapshotWorker, Step 6) reads these to scope the recompute to
   * the right tenant schema and to dedupe redelivered messages via
   * platform_event_consumer_idempotency. These headers are forward-compatible
   * with the ADR-057 envelope landing in Cycle 3.
   */
  private tenantHeaders(): Record<string, string> {
    var tenant = getCurrentTenant();
    return {
      'event-id': generateId(),
      'tenant-id': tenant.schoolId,
      'tenant-subdomain': tenant.subdomain,
    };
  }
}
