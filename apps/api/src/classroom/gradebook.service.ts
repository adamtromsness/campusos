import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { AssignmentService } from './assignment.service';
import {
  GradebookClassResponseDto,
  GradebookClassRowDto,
  GradebookSnapshotDto,
  GradebookStudentResponseDto,
  GradebookStudentRowDto,
} from './dto/gradebook.dto';
import {
  StudentClassAssignmentRowDto,
  StudentClassGradesResponseDto,
} from './dto/student-grades.dto';

interface SnapshotRow {
  id: string;
  class_id: string;
  student_id: string;
  term_id: string;
  current_average: string | null;
  letter_grade: string | null;
  assignments_graded: number;
  assignments_total: number;
  last_grade_event_at: Date | string | null;
  last_updated_at: Date | string;
}

function snapToDto(s: SnapshotRow): GradebookSnapshotDto {
  return {
    id: s.id,
    classId: s.class_id,
    studentId: s.student_id,
    termId: s.term_id,
    currentAverage: s.current_average !== null ? Number(s.current_average) : null,
    letterGrade: s.letter_grade,
    assignmentsGraded: Number(s.assignments_graded),
    assignmentsTotal: Number(s.assignments_total),
    lastGradeEventAt:
      s.last_grade_event_at === null
        ? null
        : typeof s.last_grade_event_at === 'string'
          ? s.last_grade_event_at
          : s.last_grade_event_at.toISOString(),
    lastUpdatedAt:
      typeof s.last_updated_at === 'string' ? s.last_updated_at : s.last_updated_at.toISOString(),
  };
}

@Injectable()
export class GradebookService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly assignments: AssignmentService,
  ) {}

  /**
   * Resolve a term id: if `requested` is set, use it (404 if missing); else
   * find the term whose date range covers today, falling back to the most
   * recent term across all academic years. Returns null only when the tenant
   * has no terms at all.
   */
  private async resolveTermId(requested: string | undefined): Promise<string | null> {
    if (requested !== undefined) {
      var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ id: string }>>(
          'SELECT id FROM sis_terms WHERE id = $1::uuid',
          requested,
        );
      });
      if (rows.length === 0) {
        throw new NotFoundException('Term ' + requested + ' not found');
      }
      return requested;
    }
    var current = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id FROM sis_terms ' +
          'WHERE CURRENT_DATE BETWEEN start_date AND end_date ' +
          'ORDER BY start_date DESC LIMIT 1',
      );
    });
    if (current.length > 0) return current[0]!.id;
    var fallback = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id FROM sis_terms ORDER BY start_date DESC LIMIT 1',
      );
    });
    return fallback.length > 0 ? fallback[0]!.id : null;
  }

  /**
   * Teacher / admin view of a class gradebook. Returns one row per actively
   * enrolled student, joined to the snapshot for the resolved term (null if
   * the student has no published grades yet).
   */
  async getClassGradebook(
    classId: string,
    requestedTermId: string | undefined,
    actor: ResolvedActor,
  ): Promise<GradebookClassResponseDto> {
    await this.assignments.assertCanReadClass(classId, actor);
    var termId = await this.resolveTermId(requestedTermId);

    var classRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{
          id: string;
          section_code: string | null;
          course_code: string | null;
          course_name: string | null;
        }>
      >(
        'SELECT c.id, c.section_code, co.code AS course_code, co.name AS course_name ' +
          'FROM sis_classes c ' +
          'LEFT JOIN sis_courses co ON co.id = c.course_id ' +
          'WHERE c.id = $1::uuid',
        classId,
      );
    });
    if (classRows.length === 0) {
      throw new NotFoundException('Class ' + classId + ' not found');
    }
    var classRow = classRows[0]!;

    var roster = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{
          student_id: string;
          student_number: string | null;
          first_name: string;
          last_name: string;
        }>
      >(
        'SELECT st.id AS student_id, st.student_number, ip.first_name, ip.last_name ' +
          'FROM sis_enrollments e ' +
          'JOIN sis_students st ON st.id = e.student_id ' +
          'JOIN platform.platform_students ps ON ps.id = st.platform_student_id ' +
          'JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
          "WHERE e.class_id = $1::uuid AND e.status = 'ACTIVE' " +
          'ORDER BY ip.last_name, ip.first_name',
        classId,
      );
    });

    var snapshots: SnapshotRow[] = termId
      ? await this.tenantPrisma.executeInTenantContext(async (client) => {
          return client.$queryRawUnsafe<SnapshotRow[]>(
            'SELECT id, class_id, student_id, term_id, current_average, letter_grade, ' +
              'assignments_graded, assignments_total, last_grade_event_at, last_updated_at ' +
              'FROM cls_gradebook_snapshots WHERE class_id = $1::uuid AND term_id = $2::uuid',
            classId,
            termId,
          );
        })
      : [];
    var snapByStudent = new Map<string, SnapshotRow>();
    for (var i = 0; i < snapshots.length; i++)
      snapByStudent.set(snapshots[i]!.student_id, snapshots[i]!);

    var rows: GradebookClassRowDto[] = roster.map(function (r) {
      var snap = snapByStudent.get(r.student_id);
      return {
        student: {
          id: r.student_id,
          studentNumber: r.student_number,
          firstName: r.first_name,
          lastName: r.last_name,
          fullName: r.first_name + ' ' + r.last_name,
        },
        snapshot: snap ? snapToDto(snap) : null,
      };
    });

    return {
      class: {
        id: classRow.id,
        sectionCode: classRow.section_code,
        courseCode: classRow.course_code,
        courseName: classRow.course_name,
      },
      termId: termId,
      rows: rows,
    };
  }

  /**
   * Student / parent / teacher view of a single student's gradebook across
   * all of their actively-enrolled classes for the resolved term.
   *
   * Authorisation:
   *  - Admin → ok.
   *  - Student → must be self.
   *  - Guardian → must be linked via sis_student_guardians.
   *  - Teacher → must teach at least one class the student is enrolled in
   *    (mirrors student.service visibility).
   */
  async getStudentGradebook(
    studentId: string,
    requestedTermId: string | undefined,
    actor: ResolvedActor,
  ): Promise<GradebookStudentResponseDto> {
    await this.assertCanViewStudent(studentId, actor);
    var termId = await this.resolveTermId(requestedTermId);

    var studentRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{
          id: string;
          student_number: string | null;
          first_name: string;
          last_name: string;
        }>
      >(
        'SELECT st.id, st.student_number, ip.first_name, ip.last_name ' +
          'FROM sis_students st ' +
          'JOIN platform.platform_students ps ON ps.id = st.platform_student_id ' +
          'JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
          'WHERE st.id = $1::uuid',
        studentId,
      );
    });
    if (studentRows.length === 0) {
      throw new NotFoundException('Student ' + studentId + ' not found');
    }
    var stu = studentRows[0]!;

    var classes = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{
          class_id: string;
          section_code: string | null;
          course_code: string | null;
          course_name: string | null;
        }>
      >(
        'SELECT c.id AS class_id, c.section_code, co.code AS course_code, co.name AS course_name ' +
          'FROM sis_enrollments e ' +
          'JOIN sis_classes c ON c.id = e.class_id ' +
          'LEFT JOIN sis_courses co ON co.id = c.course_id ' +
          "WHERE e.student_id = $1::uuid AND e.status = 'ACTIVE' " +
          'ORDER BY c.section_code',
        studentId,
      );
    });

    var snapshots: SnapshotRow[] = termId
      ? await this.tenantPrisma.executeInTenantContext(async (client) => {
          return client.$queryRawUnsafe<SnapshotRow[]>(
            'SELECT id, class_id, student_id, term_id, current_average, letter_grade, ' +
              'assignments_graded, assignments_total, last_grade_event_at, last_updated_at ' +
              'FROM cls_gradebook_snapshots WHERE student_id = $1::uuid AND term_id = $2::uuid',
            studentId,
            termId,
          );
        })
      : [];
    var snapByClass = new Map<string, SnapshotRow>();
    for (var i = 0; i < snapshots.length; i++)
      snapByClass.set(snapshots[i]!.class_id, snapshots[i]!);

    var rows: GradebookStudentRowDto[] = classes.map(function (c) {
      var snap = snapByClass.get(c.class_id);
      return {
        class: {
          id: c.class_id,
          sectionCode: c.section_code,
          courseCode: c.course_code,
          courseName: c.course_name,
        },
        snapshot: snap ? snapToDto(snap) : null,
      };
    });

    return {
      student: {
        id: stu.id,
        studentNumber: stu.student_number,
        firstName: stu.first_name,
        lastName: stu.last_name,
        fullName: stu.first_name + ' ' + stu.last_name,
      },
      termId: termId,
      rows: rows,
    };
  }

  /**
   * Authorisation gate for student-scoped reads. Mirrors the visibility
   * predicate in sis/student.service.ts but expressed as a yes/no check.
   * 404 over 403: admins / linked persons see the student; everyone else
   * gets "not found".
   */
  private async assertCanViewStudent(studentId: string, actor: ResolvedActor): Promise<void> {
    var existsRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid',
        studentId,
      );
    });
    if (existsRows.length === 0) {
      throw new NotFoundException('Student ' + studentId + ' not found');
    }
    if (actor.isSchoolAdmin) return;

    var visible = await this.tenantPrisma.executeInTenantContext(async (client) => {
      switch (actor.personType) {
        case 'STUDENT': {
          var rows = await client.$queryRawUnsafe<Array<{ ok: number }>>(
            'SELECT 1 AS ok FROM sis_students s ' +
              'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
              'WHERE s.id = $1::uuid AND ps.person_id = $2::uuid',
            studentId,
            actor.personId,
          );
          return rows.length > 0;
        }
        case 'GUARDIAN': {
          var rows2 = await client.$queryRawUnsafe<Array<{ ok: number }>>(
            'SELECT 1 AS ok FROM sis_student_guardians sg ' +
              'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
              'WHERE sg.student_id = $1::uuid AND g.person_id = $2::uuid',
            studentId,
            actor.personId,
          );
          return rows2.length > 0;
        }
        case 'STAFF': {
          var rows3 = await client.$queryRawUnsafe<Array<{ ok: number }>>(
            'SELECT 1 AS ok FROM sis_enrollments e ' +
              'JOIN sis_class_teachers ct ON ct.class_id = e.class_id ' +
              "WHERE e.student_id = $1::uuid AND e.status = 'ACTIVE' " +
              'AND ct.teacher_employee_id = $2::uuid',
            studentId,
            actor.personId,
          );
          return rows3.length > 0;
        }
        default:
          return false;
      }
    });
    if (!visible) {
      throw new NotFoundException('Student ' + studentId + ' not found');
    }
  }

  /**
   * Per-class assignment breakdown for one student. Drives both the student's
   * own /grades view and the parent's child-grade detail view.
   *
   * Visibility:
   *  - Caller must pass `assertCanViewStudent` (admin / self / linked guardian /
   *    teacher of an enrolled class).
   *  - Caller must additionally be able to read the class — student/parent must
   *    have an active enrollment / linked-child enrollment in the class;
   *    teachers must be assigned to the class; admins always pass.
   *  - Non-managers (anyone except teacher-of-class / admin) only see published
   *    assignments and published grades. Drafts come back as `null` for the
   *    grade and are omitted from the assignment list.
   */
  async getStudentClassGrades(
    studentId: string,
    classId: string,
    actor: ResolvedActor,
  ): Promise<StudentClassGradesResponseDto> {
    await this.assertCanViewStudent(studentId, actor);
    await this.assignments.assertCanReadClass(classId, actor);

    var enrollRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM sis_enrollments ' +
          "WHERE class_id = $1::uuid AND student_id = $2::uuid AND status = 'ACTIVE'",
        classId,
        studentId,
      );
    });
    if (enrollRows.length === 0) {
      throw new NotFoundException('Student ' + studentId + ' is not enrolled in class ' + classId);
    }

    var manager = await this.isClassManager(classId, actor);

    var classRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{
          id: string;
          section_code: string | null;
          term_id: string | null;
          course_code: string | null;
          course_name: string | null;
        }>
      >(
        'SELECT c.id, c.section_code, c.term_id, co.code AS course_code, co.name AS course_name ' +
          'FROM sis_classes c ' +
          'LEFT JOIN sis_courses co ON co.id = c.course_id ' +
          'WHERE c.id = $1::uuid',
        classId,
      );
    });
    if (classRows.length === 0) {
      throw new NotFoundException('Class ' + classId + ' not found');
    }
    var classRow = classRows[0]!;

    var studentRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{
          id: string;
          student_number: string | null;
          first_name: string;
          last_name: string;
        }>
      >(
        'SELECT st.id, st.student_number, ip.first_name, ip.last_name ' +
          'FROM sis_students st ' +
          'JOIN platform.platform_students ps ON ps.id = st.platform_student_id ' +
          'JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
          'WHERE st.id = $1::uuid',
        studentId,
      );
    });
    var stu = studentRows[0]!;

    var termId = classRow.term_id ?? (await this.resolveTermId(undefined));

    var snapshot: SnapshotRow | null = null;
    if (termId) {
      var snapRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<SnapshotRow[]>(
          'SELECT id, class_id, student_id, term_id, current_average, letter_grade, ' +
            'assignments_graded, assignments_total, last_grade_event_at, last_updated_at ' +
            'FROM cls_gradebook_snapshots ' +
            'WHERE class_id = $1::uuid AND student_id = $2::uuid AND term_id = $3::uuid',
          classId,
          studentId,
          termId,
        );
      });
      snapshot = snapRows[0] ?? null;
    }

    interface AssignmentJoinRow {
      assignment_id: string;
      a_class_id: string;
      a_title: string;
      a_instructions: string | null;
      a_due_date: Date | string | null;
      a_max_points: string;
      a_is_ai_grading_enabled: boolean;
      a_is_extra_credit: boolean;
      a_is_published: boolean;
      a_grading_scale_id: string | null;
      a_created_at: Date | string;
      a_updated_at: Date | string;
      type_id: string;
      type_name: string;
      type_category: string;
      category_id: string | null;
      category_name: string | null;
      category_weight: string | null;
      sub_id: string | null;
      sub_status: string | null;
      sub_submitted_at: Date | string | null;
      grade_id: string | null;
      grade_value: string | null;
      grade_letter: string | null;
      grade_feedback: string | null;
      grade_is_published: boolean | null;
      grade_published_at: Date | string | null;
      grade_graded_at: Date | string | null;
    }

    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<AssignmentJoinRow[]>(
        'SELECT a.id AS assignment_id, a.class_id AS a_class_id, ' +
          'a.title AS a_title, a.instructions AS a_instructions, a.due_date AS a_due_date, ' +
          'a.max_points AS a_max_points, a.is_ai_grading_enabled AS a_is_ai_grading_enabled, ' +
          'a.is_extra_credit AS a_is_extra_credit, a.is_published AS a_is_published, ' +
          'a.grading_scale_id AS a_grading_scale_id, ' +
          'a.created_at AS a_created_at, a.updated_at AS a_updated_at, ' +
          't.id AS type_id, t.name AS type_name, t.category AS type_category, ' +
          'c.id AS category_id, c.name AS category_name, c.weight AS category_weight, ' +
          's.id AS sub_id, s.status AS sub_status, s.submitted_at AS sub_submitted_at, ' +
          'g.id AS grade_id, g.grade_value, g.letter_grade AS grade_letter, ' +
          'g.feedback AS grade_feedback, g.is_published AS grade_is_published, ' +
          'g.published_at AS grade_published_at, g.graded_at AS grade_graded_at ' +
          'FROM cls_assignments a ' +
          'JOIN cls_assignment_types t ON t.id = a.assignment_type_id ' +
          'LEFT JOIN cls_assignment_categories c ON c.id = a.category_id ' +
          'LEFT JOIN cls_submissions s ON s.assignment_id = a.id AND s.student_id = $2::uuid ' +
          'LEFT JOIN cls_grades g ON g.assignment_id = a.id AND g.student_id = $2::uuid ' +
          'WHERE a.class_id = $1::uuid AND a.deleted_at IS NULL ' +
          (manager ? '' : 'AND a.is_published = true ') +
          'ORDER BY a.due_date NULLS LAST, a.created_at DESC',
        classId,
        studentId,
      );
    });

    var assignmentRows: StudentClassAssignmentRowDto[] = rows.map(function (r) {
      var maxPoints = Number(r.a_max_points);
      var assignmentDto = {
        id: r.assignment_id,
        classId: r.a_class_id,
        title: r.a_title,
        instructions: r.a_instructions,
        assignmentType: {
          id: r.type_id,
          name: r.type_name,
          category: r.type_category,
        },
        category:
          r.category_id !== null
            ? {
                id: r.category_id,
                name: r.category_name!,
                weight: Number(r.category_weight),
              }
            : null,
        gradingScaleId: r.a_grading_scale_id,
        dueDate:
          r.a_due_date === null
            ? null
            : typeof r.a_due_date === 'string'
              ? r.a_due_date
              : r.a_due_date.toISOString(),
        maxPoints: maxPoints,
        isAiGradingEnabled: r.a_is_ai_grading_enabled,
        isExtraCredit: r.a_is_extra_credit,
        isPublished: r.a_is_published,
        createdAt:
          typeof r.a_created_at === 'string' ? r.a_created_at : r.a_created_at.toISOString(),
        updatedAt:
          typeof r.a_updated_at === 'string' ? r.a_updated_at : r.a_updated_at.toISOString(),
      };

      var hasGrade = r.grade_id !== null;
      var gradePublished = r.grade_is_published === true;
      var showGrade = hasGrade && (manager || gradePublished);
      var grade = showGrade
        ? {
            id: r.grade_id!,
            gradeValue: Number(r.grade_value),
            maxPoints: maxPoints,
            percentage:
              maxPoints > 0 ? Math.round((Number(r.grade_value) / maxPoints) * 100 * 100) / 100 : 0,
            letterGrade: r.grade_letter,
            feedback: r.grade_feedback,
            isPublished: gradePublished,
            publishedAt:
              r.grade_published_at === null
                ? null
                : typeof r.grade_published_at === 'string'
                  ? r.grade_published_at
                  : r.grade_published_at.toISOString(),
            gradedAt:
              r.grade_graded_at === null
                ? ''
                : typeof r.grade_graded_at === 'string'
                  ? r.grade_graded_at
                  : r.grade_graded_at.toISOString(),
          }
        : null;

      var submission =
        r.sub_id !== null
          ? {
              id: r.sub_id,
              status: r.sub_status!,
              submittedAt:
                r.sub_submitted_at === null
                  ? null
                  : typeof r.sub_submitted_at === 'string'
                    ? r.sub_submitted_at
                    : r.sub_submitted_at.toISOString(),
            }
          : null;

      return {
        assignment: assignmentDto,
        submission: submission,
        grade: grade,
      };
    });

    return {
      class: {
        id: classRow.id,
        sectionCode: classRow.section_code,
        courseCode: classRow.course_code,
        courseName: classRow.course_name,
      },
      student: {
        id: stu.id,
        studentNumber: stu.student_number,
        firstName: stu.first_name,
        lastName: stu.last_name,
        fullName: stu.first_name + ' ' + stu.last_name,
      },
      termId: termId,
      snapshot: snapshot ? snapToDto(snapshot) : null,
      assignments: assignmentRows,
    };
  }

  /**
   * Whether the actor is a manager (teacher-of-class or admin) of the given
   * class. Used to decide whether draft grades / unpublished assignments are
   * surfaced in getStudentClassGrades.
   */
  private async isClassManager(classId: string, actor: ResolvedActor): Promise<boolean> {
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
}
