import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { AssignmentService } from './assignment.service';
import {
  SubmitAssignmentDto,
  SubmissionResponseDto,
  TeacherSubmissionListResponseDto,
} from './dto/submission.dto';

interface SubmissionRow {
  id: string;
  assignment_id: string;
  class_id: string;
  student_sis_id: string;
  student_number: string | null;
  first_name: string;
  last_name: string;
  status: string;
  submission_text: string | null;
  attachments: any;
  submitted_at: Date | string | null;
  returned_at: Date | string | null;
  return_reason: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  grade_id: string | null;
  grade_value: string | null;
  grade_letter: string | null;
  grade_feedback: string | null;
  grade_is_published: boolean | null;
  grade_published_at: Date | string | null;
  grade_graded_at: Date | string | null;
}

function toIso(v: Date | string | null): string | null {
  if (v === null) return null;
  return typeof v === 'string' ? v : v.toISOString();
}

/**
 * Build the response DTO. `includeDraftGrade` controls whether unpublished
 * cls_grades fields surface in the `grade` slot — true for managers
 * (teacher-of-class / admin), false for students / parents so they never
 * see a teacher's working draft.
 */
function rowToDto(r: SubmissionRow, includeDraftGrade: boolean): SubmissionResponseDto {
  var hasGrade = r.grade_id !== null;
  var gradePublished = r.grade_is_published === true;
  var showGrade = hasGrade && (includeDraftGrade || gradePublished);
  return {
    id: r.id,
    assignmentId: r.assignment_id,
    classId: r.class_id,
    student: {
      id: r.student_sis_id,
      studentNumber: r.student_number,
      firstName: r.first_name,
      lastName: r.last_name,
      fullName: r.first_name + ' ' + r.last_name,
    },
    status: r.status,
    submissionText: r.submission_text,
    attachments: Array.isArray(r.attachments) ? r.attachments : [],
    submittedAt: toIso(r.submitted_at),
    returnedAt: toIso(r.returned_at),
    returnReason: r.return_reason,
    grade: showGrade
      ? {
          id: r.grade_id!,
          gradeValue: Number(r.grade_value),
          letterGrade: r.grade_letter,
          feedback: r.grade_feedback,
          isPublished: gradePublished,
          publishedAt: toIso(r.grade_published_at),
          gradedAt: toIso(r.grade_graded_at) || '',
        }
      : null,
    createdAt: toIso(r.created_at) || '',
    updatedAt: toIso(r.updated_at) || '',
  };
}

var SELECT_SUBMISSION_BASE =
  'SELECT s.id, s.assignment_id, a.class_id, ' +
  's.student_id AS student_sis_id, ' +
  'st.student_number, ip.first_name, ip.last_name, ' +
  's.status, s.submission_text, s.attachments, ' +
  's.submitted_at, s.returned_at, s.return_reason, ' +
  's.created_at, s.updated_at, ' +
  'g.id AS grade_id, g.grade_value, g.letter_grade AS grade_letter, ' +
  'g.feedback AS grade_feedback, g.is_published AS grade_is_published, ' +
  'g.published_at AS grade_published_at, g.graded_at AS grade_graded_at ' +
  'FROM cls_submissions s ' +
  'JOIN cls_assignments a ON a.id = s.assignment_id ' +
  'JOIN sis_students st ON st.id = s.student_id ' +
  'JOIN platform.platform_students ps ON ps.id = st.platform_student_id ' +
  'JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
  'LEFT JOIN cls_grades g ON g.assignment_id = s.assignment_id AND g.student_id = s.student_id ';

interface AssignmentMeta {
  id: string;
  classId: string;
  isPublished: boolean;
  isDeleted: boolean;
  maxPoints: number;
  isExtraCredit: boolean;
}

@Injectable()
export class SubmissionService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly assignments: AssignmentService,
    private readonly kafka: KafkaProducerService,
  ) {}

  /**
   * Look up the assignment metadata + check it isn't soft-deleted. Throws 404
   * if missing. Used by submit() and the teacher list endpoint to resolve
   * class_id without going through the full assignment DTO.
   */
  private async loadAssignmentMeta(assignmentId: string): Promise<AssignmentMeta> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{
          id: string;
          class_id: string;
          is_published: boolean;
          deleted_at: Date | null;
          max_points: string;
          is_extra_credit: boolean;
        }>
      >(
        'SELECT id, class_id, is_published, deleted_at, max_points, is_extra_credit ' +
          'FROM cls_assignments WHERE id = $1::uuid',
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
    };
  }

  /**
   * Resolve the calling student's sis_students.id from their iam_person.id.
   * Throws 403 if the actor isn't a STUDENT or has no sis_students row in
   * this tenant — both indistinguishable from "not enrolled here".
   */
  private async resolveCallingStudentSisId(actor: ResolvedActor): Promise<string> {
    if (actor.personType !== 'STUDENT') {
      throw new ForbiddenException('Only students can submit assignments via this endpoint');
    }
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT s.id FROM sis_students s ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'WHERE ps.person_id = $1::uuid',
        actor.personId,
      );
    });
    if (rows.length === 0) {
      throw new ForbiddenException('No student record for the calling user in this school');
    }
    return rows[0]!.id;
  }

  /**
   * Verify the (student, class) pair has an active enrollment row.
   */
  private async assertEnrolled(classId: string, studentSisId: string): Promise<void> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM sis_enrollments ' +
          "WHERE class_id = $1::uuid AND student_id = $2::uuid AND status = 'ACTIVE'",
        classId,
        studentSisId,
      );
    });
    if (rows.length === 0) {
      throw new ForbiddenException('You are not enrolled in this class');
    }
  }

  /**
   * Student submits their own work for an assignment.
   *
   * Behaviour:
   *  - 404 if the assignment is missing or soft-deleted.
   *  - 404 if the assignment is unpublished — students must not learn it exists.
   *  - 403 if the caller isn't a STUDENT, has no sis_students row, or isn't enrolled in the class.
   *  - Idempotent upsert by (assignment_id, student_id). Re-submitting overwrites
   *    submission_text / attachments / submitted_at and resets status to SUBMITTED.
   *  - Emits cls.submission.submitted for fresh submissions and resubmissions.
   *
   * Returns the resulting submission DTO.
   */
  async submit(
    assignmentId: string,
    body: SubmitAssignmentDto,
    actor: ResolvedActor,
  ): Promise<SubmissionResponseDto> {
    var meta = await this.loadAssignmentMeta(assignmentId);
    if (meta.isDeleted || !meta.isPublished) {
      throw new NotFoundException('Assignment ' + assignmentId + ' not found');
    }
    var studentSisId = await this.resolveCallingStudentSisId(actor);
    await this.assertEnrolled(meta.classId, studentSisId);

    var attachmentsJson = JSON.stringify(body.attachments ?? []);
    var nowIso = new Date().toISOString();

    var submissionId = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var existing = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id FROM cls_submissions WHERE assignment_id = $1::uuid AND student_id = $2::uuid',
        assignmentId,
        studentSisId,
      );
      if (existing.length > 0) {
        var subId = existing[0]!.id;
        await tx.$executeRawUnsafe(
          'UPDATE cls_submissions SET ' +
            "status = 'SUBMITTED', " +
            'submission_text = $1, ' +
            'attachments = $2::jsonb, ' +
            'submitted_at = now(), ' +
            'updated_at = now() ' +
            'WHERE id = $3::uuid',
          body.submissionText ?? null,
          attachmentsJson,
          subId,
        );
        return subId;
      }
      var newId = generateId();
      await tx.$executeRawUnsafe(
        'INSERT INTO cls_submissions ' +
          '(id, assignment_id, student_id, status, submission_text, attachments, submitted_at) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, 'SUBMITTED', $4, $5::jsonb, now())",
        newId,
        assignmentId,
        studentSisId,
        body.submissionText ?? null,
        attachmentsJson,
      );
      return newId;
    });

    void this.kafka.emit({
      topic: 'cls.submission.submitted',
      key: studentSisId,
      sourceModule: 'classroom',
      occurredAt: nowIso,
      payload: {
        submissionId: submissionId,
        assignmentId: assignmentId,
        classId: meta.classId,
        studentId: studentSisId,
        submittedAt: nowIso,
      },
    });

    return this.getById(submissionId, actor);
  }

  private async isManagerOfClass(classId: string, actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    if (actor.personType !== 'STAFF') return false;
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM sis_class_teachers ' +
          'WHERE class_id = $1::uuid AND teacher_employee_id = $2::uuid',
        classId,
        actor.personId,
      );
    });
    return rows.length > 0;
  }

  /**
   * Single-row read by id. Authorises against the parent class:
   *   - Teacher-of-class / admin → ok.
   *   - Owning student → ok.
   *   - Anything else → 404.
   */
  async getById(submissionId: string, actor: ResolvedActor): Promise<SubmissionResponseDto> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<SubmissionRow[]>(
        SELECT_SUBMISSION_BASE + 'WHERE s.id = $1::uuid',
        submissionId,
      );
    });
    if (rows.length === 0) {
      throw new NotFoundException('Submission ' + submissionId + ' not found');
    }
    var row = rows[0]!;
    var visible = await this.canSeeSubmission(row, actor);
    if (!visible) {
      throw new NotFoundException('Submission ' + submissionId + ' not found');
    }
    var manager = await this.isManagerOfClass(row.class_id, actor);
    return rowToDto(row, manager);
  }

  /**
   * Teacher / admin view: all submissions for this assignment, joined with
   * the roster so students with no submission yet still appear (status
   * NOT_STARTED, no row id, no grade).
   *
   * Counts include only real cls_submissions rows.
   */
  async listForAssignment(
    assignmentId: string,
    actor: ResolvedActor,
  ): Promise<TeacherSubmissionListResponseDto> {
    var meta = await this.loadAssignmentMeta(assignmentId);
    if (meta.isDeleted) {
      throw new NotFoundException('Assignment ' + assignmentId + ' not found');
    }
    // Manager-only: hard-fail for non-teachers / non-admins.
    await this.assignments.assertCanWriteClass(meta.classId, actor);

    var rosterRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{
          student_sis_id: string;
          student_number: string | null;
          first_name: string;
          last_name: string;
        }>
      >(
        'SELECT st.id AS student_sis_id, st.student_number, ip.first_name, ip.last_name ' +
          'FROM sis_enrollments e ' +
          'JOIN sis_students st ON st.id = e.student_id ' +
          'JOIN platform.platform_students ps ON ps.id = st.platform_student_id ' +
          'JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
          "WHERE e.class_id = $1::uuid AND e.status = 'ACTIVE' " +
          'ORDER BY ip.last_name, ip.first_name',
        meta.classId,
      );
    });

    var subRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<SubmissionRow[]>(
        SELECT_SUBMISSION_BASE + 'WHERE s.assignment_id = $1::uuid',
        assignmentId,
      );
    });
    var subByStudent = new Map<string, SubmissionRow>();
    for (var si = 0; si < subRows.length; si++) {
      subByStudent.set(subRows[si]!.student_sis_id, subRows[si]!);
    }

    var combined: SubmissionResponseDto[] = [];
    var submittedCount = 0;
    var gradedCount = 0;
    var publishedCount = 0;
    for (var ri = 0; ri < rosterRows.length; ri++) {
      var rr = rosterRows[ri]!;
      var sub = subByStudent.get(rr.student_sis_id);
      if (sub) {
        // Teacher / admin context — show drafts so the grading UI can
        // render in-progress entries.
        combined.push(rowToDto(sub, true));
        if (sub.status === 'SUBMITTED' || sub.status === 'GRADED' || sub.status === 'RETURNED') {
          submittedCount++;
        }
        if (sub.grade_id !== null) {
          gradedCount++;
          if (sub.grade_is_published === true) publishedCount++;
        }
      } else {
        combined.push({
          id: '',
          assignmentId: assignmentId,
          classId: meta.classId,
          student: {
            id: rr.student_sis_id,
            studentNumber: rr.student_number,
            firstName: rr.first_name,
            lastName: rr.last_name,
            fullName: rr.first_name + ' ' + rr.last_name,
          },
          status: 'NOT_STARTED',
          submissionText: null,
          attachments: [],
          submittedAt: null,
          returnedAt: null,
          returnReason: null,
          grade: null,
          createdAt: '',
          updatedAt: '',
        });
      }
    }
    return {
      assignmentId: assignmentId,
      classId: meta.classId,
      rosterSize: rosterRows.length,
      submittedCount: submittedCount,
      gradedCount: gradedCount,
      publishedCount: publishedCount,
      submissions: combined,
    };
  }

  /**
   * Student view: a single submission for the calling student on this
   * assignment, or null if they haven't submitted yet. Throws 404 if the
   * assignment is missing / unpublished / they aren't enrolled.
   */
  async listMineForAssignment(
    assignmentId: string,
    actor: ResolvedActor,
  ): Promise<SubmissionResponseDto | null> {
    var meta = await this.loadAssignmentMeta(assignmentId);
    if (meta.isDeleted || !meta.isPublished) {
      throw new NotFoundException('Assignment ' + assignmentId + ' not found');
    }
    if (actor.personType !== 'STUDENT') {
      throw new ForbiddenException('This endpoint is only available to student callers');
    }
    var studentSisId = await this.resolveCallingStudentSisId(actor);
    await this.assertEnrolled(meta.classId, studentSisId);

    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<SubmissionRow[]>(
        SELECT_SUBMISSION_BASE + 'WHERE s.assignment_id = $1::uuid AND s.student_id = $2::uuid',
        assignmentId,
        studentSisId,
      );
    });
    if (rows.length === 0) return null;
    // Student is never a manager of their own class — hide draft grades.
    return rowToDto(rows[0]!, false);
  }

  /**
   * Whether the actor can read a specific submission row. Used by getById()
   * to decide between 200 and 404.
   */
  private async canSeeSubmission(row: SubmissionRow, actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    if (actor.personType === 'STAFF') {
      // Teacher must be assigned to the class.
      var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_class_teachers ' +
            'WHERE class_id = $1::uuid AND teacher_employee_id = $2::uuid',
          row.class_id,
          actor.personId,
        );
      });
      return rows.length > 0;
    }
    if (actor.personType === 'STUDENT') {
      var rows2 = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_students s ' +
            'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
            'WHERE s.id = $1::uuid AND ps.person_id = $2::uuid',
          row.student_sis_id,
          actor.personId,
        );
      });
      return rows2.length > 0;
    }
    if (actor.personType === 'GUARDIAN') {
      var rows3 = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_student_guardians sg ' +
            'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            'WHERE sg.student_id = $1::uuid AND g.person_id = $2::uuid',
          row.student_sis_id,
          actor.personId,
        );
      });
      return rows3.length > 0;
    }
    return false;
  }
}
