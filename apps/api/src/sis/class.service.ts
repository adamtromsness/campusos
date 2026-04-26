import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { ListClassesQueryDto, ClassResponseDto, RosterEntryDto } from './dto/class.dto';

interface ClassRow {
  id: string;
  school_id: string;
  section_code: string;
  room: string | null;
  max_enrollment: number | null;
  course_id: string;
  course_code: string;
  course_name: string;
  course_grade_level: string | null;
  year_id: string;
  year_name: string;
  year_is_current: boolean;
  term_id: string | null;
  term_name: string | null;
  term_type: string | null;
  enrollment_count: number;
}

interface ClassTeacherRow {
  class_id: string;
  person_id: string;
  first_name: string;
  last_name: string;
  is_primary_teacher: boolean;
}

interface RosterRow {
  enrollment_id: string;
  status: string;
  student_id: string;
  student_number: string | null;
  grade_level: string | null;
  first_name: string;
  last_name: string;
}

function classRowToDto(row: ClassRow, teachers: ClassTeacherRow[]): ClassResponseDto {
  return {
    id: row.id,
    schoolId: row.school_id,
    sectionCode: row.section_code,
    room: row.room,
    maxEnrollment: row.max_enrollment,
    course: {
      id: row.course_id,
      code: row.course_code,
      name: row.course_name,
      gradeLevel: row.course_grade_level,
    },
    academicYear: {
      id: row.year_id,
      name: row.year_name,
      isCurrent: row.year_is_current,
    },
    term: row.term_id
      ? { id: row.term_id, name: row.term_name!, termType: row.term_type! }
      : null,
    teachers: teachers
      .filter(function(t) { return t.class_id === row.id; })
      .map(function(t) {
        return {
          personId: t.person_id,
          fullName: t.first_name + ' ' + t.last_name,
          isPrimaryTeacher: t.is_primary_teacher,
        };
      }),
    enrollmentCount: Number(row.enrollment_count),
  };
}

var CLASS_SELECT_BASE =
  'SELECT c.id, c.school_id, c.section_code, c.room, c.max_enrollment, ' +
    'co.id AS course_id, co.code AS course_code, co.name AS course_name, co.grade_level AS course_grade_level, ' +
    'ay.id AS year_id, ay.name AS year_name, ay.is_current AS year_is_current, ' +
    't.id AS term_id, t.name AS term_name, t.term_type, ' +
    '(SELECT count(*)::int FROM sis_enrollments e WHERE e.class_id = c.id AND e.status = \'ACTIVE\') AS enrollment_count ' +
  'FROM sis_classes c ' +
  'JOIN sis_courses co ON co.id = c.course_id ' +
  'JOIN sis_academic_years ay ON ay.id = c.academic_year_id ' +
  'LEFT JOIN sis_terms t ON t.id = c.term_id ';

@Injectable()
export class ClassService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async list(filters: ListClassesQueryDto): Promise<ClassResponseDto[]> {
    var result = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var rows = await client.$queryRawUnsafe<ClassRow[]>(
        CLASS_SELECT_BASE +
        'WHERE ($1::uuid IS NULL OR c.term_id = $1::uuid) ' +
          'AND ($2::uuid IS NULL OR c.course_id = $2::uuid) ' +
          'AND ($3::uuid IS NULL OR c.academic_year_id = $3::uuid) ' +
          'AND ($4::text IS NULL OR co.grade_level = $4::text) ' +
        'ORDER BY c.section_code',
        filters.termId ?? null,
        filters.courseId ?? null,
        filters.academicYearId ?? null,
        filters.gradeLevel ?? null,
      );
      var teachers = await this.loadTeachersForClasses(client, rows.map(function(r) { return r.id; }));
      return { rows: rows, teachers: teachers };
    });
    return result.rows.map(function(r) { return classRowToDto(r, result.teachers); });
  }

  async getById(id: string): Promise<ClassResponseDto> {
    var result = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var rows = await client.$queryRawUnsafe<ClassRow[]>(
        CLASS_SELECT_BASE + 'WHERE c.id = $1::uuid',
        id,
      );
      if (rows.length === 0) return null;
      var teachers = await this.loadTeachersForClasses(client, [id]);
      return { row: rows[0]!, teachers: teachers };
    });
    if (!result) throw new NotFoundException('Class ' + id + ' not found');
    return classRowToDto(result.row, result.teachers);
  }

  /**
   * Classes taught by the given teacher, identified by their iam_person.id.
   * (We seeded sis_class_teachers.teacher_employee_id with iam_person.id; an HR module
   *  will later remap this to hr_employees but the lookup pattern remains.)
   */
  async listForTeacherPerson(teacherPersonId: string): Promise<ClassResponseDto[]> {
    var result = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var rows = await client.$queryRawUnsafe<ClassRow[]>(
        CLASS_SELECT_BASE +
        'WHERE c.id IN (SELECT class_id FROM sis_class_teachers WHERE teacher_employee_id = $1::uuid) ' +
        'ORDER BY c.section_code',
        teacherPersonId,
      );
      var teachers = await this.loadTeachersForClasses(client, rows.map(function(r) { return r.id; }));
      return { rows: rows, teachers: teachers };
    });
    return result.rows.map(function(r) { return classRowToDto(r, result.teachers); });
  }

  async getRoster(classId: string): Promise<RosterEntryDto[]> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      // 404 if class doesn't exist
      var existence = await client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id FROM sis_classes WHERE id = $1::uuid',
        classId,
      );
      if (existence.length === 0) throw new NotFoundException('Class ' + classId + ' not found');

      return client.$queryRawUnsafe<RosterRow[]>(
        'SELECT e.id AS enrollment_id, e.status, ' +
          's.id AS student_id, s.student_number, s.grade_level, ' +
          'ip.first_name, ip.last_name ' +
        'FROM sis_enrollments e ' +
        'JOIN sis_students s ON s.id = e.student_id ' +
        'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
        'JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
        'WHERE e.class_id = $1::uuid AND e.status = \'ACTIVE\' ' +
        'ORDER BY ip.last_name, ip.first_name',
        classId,
      );
    });
    return rows.map(function(r) {
      return {
        enrollmentId: r.enrollment_id,
        studentId: r.student_id,
        studentNumber: r.student_number,
        firstName: r.first_name,
        lastName: r.last_name,
        fullName: r.first_name + ' ' + r.last_name,
        gradeLevel: r.grade_level,
        enrollmentStatus: r.status,
      };
    });
  }

  private async loadTeachersForClasses(client: any, classIds: string[]): Promise<ClassTeacherRow[]> {
    if (classIds.length === 0) return [];
    // Cast each id explicitly via VALUES list to avoid string→uuid array binding gotchas.
    var placeholders = classIds.map(function(_, idx) { return '$' + (idx + 1) + '::uuid'; }).join(',');
    return client.$queryRawUnsafe(
      'SELECT ct.class_id, ct.is_primary_teacher, ' +
        'ip.id AS person_id, ip.first_name, ip.last_name ' +
      'FROM sis_class_teachers ct ' +
      'JOIN platform.iam_person ip ON ip.id = ct.teacher_employee_id ' +
      'WHERE ct.class_id IN (' + placeholders + ')',
      ...classIds,
    );
  }
}
