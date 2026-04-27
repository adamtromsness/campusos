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
      typeof s.last_updated_at === 'string'
        ? s.last_updated_at
        : s.last_updated_at.toISOString(),
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
    for (var i = 0; i < snapshots.length; i++) snapByStudent.set(snapshots[i]!.student_id, snapshots[i]!);

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
    for (var i = 0; i < snapshots.length; i++) snapByClass.set(snapshots[i]!.class_id, snapshots[i]!);

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
}
