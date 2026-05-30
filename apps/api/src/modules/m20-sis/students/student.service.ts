import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { PersonaResolutionService } from '@modules/m00-platform/iam/persona-resolution.service';
import {
  CreateStudentDto,
  UpdateStudentDto,
  StudentResponseDto,
  ListStudentsQueryDto,
} from './dto/student.dto';

interface StudentRow {
  id: string;
  student_number: string | null;
  grade_level: string | null;
  enrollment_status: string;
  homeroom_class_id: string | null;
  school_id: string;
  platform_student_id: string;
  person_id: string;
  first_name: string;
  last_name: string;
}

function rowToDto(row: StudentRow): StudentResponseDto {
  return {
    id: row.id,
    studentNumber: row.student_number,
    firstName: row.first_name,
    lastName: row.last_name,
    fullName: row.first_name + ' ' + row.last_name,
    gradeLevel: row.grade_level,
    enrollmentStatus: row.enrollment_status,
    homeroomClassId: row.homeroom_class_id,
    schoolId: row.school_id,
    personId: row.person_id,
    platformStudentId: row.platform_student_id,
  };
}

/**
 * Row-level visibility predicate for the calling actor.
 *
 * Returns a SQL fragment ANDed into student-list queries plus the parameter
 * value bound to it (UUID, cast in the SQL via `$N::uuid`). The fragment is
 * pinned so that it applies wherever an `s.id` (sis_students.id) is in scope.
 *
 * - Admins (school admin or platform admin) → no filter (school-wide).
 * - Guardians → only students linked via sis_student_guardians/sis_guardians.
 * - Students → only their own sis_students row (resolved via platform_students.person_id).
 * - Teachers (STAFF) → only students enrolled in classes where they are
 *   listed in sis_class_teachers.teacher_employee_id (Cycle 4 Step 0:
 *   bound from actor.employeeId, the calling iam_person's hr_employees row).
 * - Anything else (volunteers, external, etc.) → no rows.
 *
 * The placeholder index is the caller's `$start`; the function returns the
 * index it consumed (0 or 1) so callers can keep their parameter list dense.
 */
interface VisibilityClause {
  fragment: string;
  param: string | null;
  consumed: 0 | 1;
}

function visibilityClause(actor: ResolvedActor, start: number): VisibilityClause {
  if (actor.isSchoolAdmin) {
    return { fragment: '', param: null, consumed: 0 };
  }
  switch (actor.personType) {
    case 'GUARDIAN':
      return {
        fragment:
          'AND s.id IN (' +
          'SELECT sg.student_id FROM sis_student_guardians sg ' +
          'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
          'WHERE g.person_id = $' +
          start +
          '::uuid' +
          ') ',
        param: actor.personId,
        consumed: 1,
      };
    case 'STUDENT':
      return {
        fragment:
          'AND s.platform_student_id IN (' +
          'SELECT ps.id FROM platform.platform_students ps WHERE ps.person_id = $' +
          start +
          '::uuid' +
          ') ',
        param: actor.personId,
        consumed: 1,
      };
    case 'STAFF':
      // Teacher with no hr_employees row (e.g. the synthetic Platform Admin
      // persona) sees no rows via this predicate; school-admin bypass at the
      // top of visibilityClause handles the legitimate admin case.
      if (!actor.employeeId) {
        return { fragment: 'AND FALSE ', param: null, consumed: 0 };
      }
      return {
        fragment:
          'AND s.id IN (' +
          'SELECT e.student_id FROM sis_enrollments e ' +
          'JOIN sis_class_teachers ct ON ct.class_id = e.class_id ' +
          "WHERE e.status = 'ACTIVE' AND ct.teacher_employee_id = $" +
          start +
          '::uuid' +
          ') ',
        param: actor.employeeId,
        consumed: 1,
      };
    default:
      // Volunteers, external roles, no person record, etc. → no rows.
      return { fragment: 'AND FALSE ', param: null, consumed: 0 };
  }
}

@Injectable()
export class StudentService {
  private readonly logger = new Logger(StudentService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    // @Optional so test fixtures that only need student CRUD can
    // construct StudentService with a single arg (mirrors how
    // PermissionCheckService treats RedisService + MetricsService).
    // The auto-alumni hook short-circuits when this is undefined.
    @Optional() private readonly personaResolution?: PersonaResolutionService,
  ) {}

  async list(filters: ListStudentsQueryDto, actor: ResolvedActor): Promise<StudentResponseDto[]> {
    var tenant = getCurrentTenant();
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var vis = visibilityClause(actor, 5);
      var sql =
        'SELECT s.id, s.student_number, s.grade_level, s.enrollment_status, ' +
        's.homeroom_class_id, s.school_id, s.platform_student_id, ' +
        'ip.id AS person_id, ip.first_name, ip.last_name ' +
        'FROM sis_students s ' +
        'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
        'JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
        "WHERE ($1::uuid IS NULL OR s.id IN (SELECT student_id FROM sis_enrollments WHERE class_id = $1::uuid AND status = 'ACTIVE')) " +
        'AND ($2::text IS NULL OR s.grade_level = $2::text) ' +
        'AND ($3::text IS NULL OR s.enrollment_status = $3::text) ' +
        'AND s.school_id = $4::uuid ' +
        vis.fragment +
        'ORDER BY ip.last_name, ip.first_name';
      var params: any[] = [
        filters.classId ?? null,
        filters.gradeLevel ?? null,
        filters.enrollmentStatus ?? null,
        tenant.schoolId,
      ];
      if (vis.param !== null) params.push(vis.param);
      return client.$queryRawUnsafe<StudentRow[]>(sql, ...params);
    });
    return rows.map(rowToDto);
  }

  /**
   * Look up a single student. Throws 404 if missing OR if the actor isn't
   * authorised to see this row — collapsing 403 into 404 deliberately so
   * the API can't be used to probe for the existence of student ids the
   * caller has no access to.
   */
  async getById(id: string, actor: ResolvedActor): Promise<StudentResponseDto> {
    var tenant = getCurrentTenant();
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var vis = visibilityClause(actor, 3);
      var sql =
        'SELECT s.id, s.student_number, s.grade_level, s.enrollment_status, ' +
        's.homeroom_class_id, s.school_id, s.platform_student_id, ' +
        'ip.id AS person_id, ip.first_name, ip.last_name ' +
        'FROM sis_students s ' +
        'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
        'JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
        'WHERE s.id = $1::uuid AND s.school_id = $2::uuid ' +
        vis.fragment;
      var params: any[] = [id, tenant.schoolId];
      if (vis.param !== null) params.push(vis.param);
      return client.$queryRawUnsafe<StudentRow[]>(sql, ...params);
    });
    if (rows.length === 0) throw new NotFoundException('Student ' + id + ' not found');
    return rowToDto(rows[0]!);
  }

  /**
   * Authorisation check for collateral reads against a student id (e.g.
   * GET /students/:id/guardians, GET /students/:id/attendance). Throws if
   * the actor cannot see the row.
   */
  async assertCanViewStudent(id: string, actor: ResolvedActor): Promise<void> {
    var tenant = getCurrentTenant();
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var vis = visibilityClause(actor, 3);
      var sql =
        'SELECT 1 AS ok FROM sis_students s WHERE s.id = $1::uuid AND s.school_id = $2::uuid ' +
        vis.fragment;
      var params: any[] = [id, tenant.schoolId];
      if (vis.param !== null) params.push(vis.param);
      return client.$queryRawUnsafe<Array<{ ok: number }>>(sql, ...params);
    });
    if (rows.length === 0) {
      throw new NotFoundException('Student ' + id + ' not found');
    }
  }

  /**
   * Return the calling student's own sis_students row. Used by `/students/me`
   * to bootstrap the studentId in the web app without scanning the full
   * student list. Throws 404 if the caller is not a STUDENT or has no
   * sis_students row in this tenant — both indistinguishable from the outside
   * to avoid probing.
   */
  async getSelfForStudent(actor: ResolvedActor): Promise<StudentResponseDto> {
    if (actor.personType !== 'STUDENT') {
      throw new NotFoundException('No student record for this caller');
    }
    var tenant = getCurrentTenant();
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<StudentRow[]>(
        'SELECT s.id, s.student_number, s.grade_level, s.enrollment_status, ' +
          's.homeroom_class_id, s.school_id, s.platform_student_id, ' +
          'ip.id AS person_id, ip.first_name, ip.last_name ' +
          'FROM sis_students s ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
          'WHERE ps.person_id = $1::uuid AND s.school_id = $2::uuid',
        actor.personId,
        tenant.schoolId,
      );
    });
    if (rows.length === 0) {
      throw new NotFoundException('No student record for this caller');
    }
    return rowToDto(rows[0]!);
  }

  /**
   * Resolve sis_students records for an authenticated guardian (req.user.personId).
   * Returns the children for whom this guardian has a sis_student_guardians link.
   *
   * This is the GUARDIAN-scoped view of `list()` and is left as a dedicated
   * method because it doesn't take filters and short-circuits the visibility
   * predicate — the personId-bound query is already the row scope.
   */
  async listForGuardianPerson(guardianPersonId: string): Promise<StudentResponseDto[]> {
    var tenant = getCurrentTenant();
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<StudentRow[]>(
        'SELECT s.id, s.student_number, s.grade_level, s.enrollment_status, ' +
          's.homeroom_class_id, s.school_id, s.platform_student_id, ' +
          'ip.id AS person_id, ip.first_name, ip.last_name ' +
          'FROM sis_students s ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
          'JOIN sis_student_guardians sg ON sg.student_id = s.id ' +
          'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
          'WHERE g.person_id = $1::uuid AND s.school_id = $2::uuid ' +
          'ORDER BY ip.last_name, ip.first_name',
        guardianPersonId,
        tenant.schoolId,
      );
    });
    return rows.map(rowToDto);
  }

  async create(input: CreateStudentDto, actor: ResolvedActor): Promise<StudentResponseDto> {
    if (!actor.isSchoolAdmin) {
      // Only school/platform admins can provision new students. The
      // PermissionGuard already enforces stu-001:write at the endpoint, but
      // we double-gate here to make the row-scope rule explicit: there is
      // no sub-admin caller persona for student creation.
      throw new ForbiddenException('Only school administrators can create students');
    }
    var tenant = getCurrentTenant();
    var schoolId = tenant.schoolId;

    // Atomic three-table insert across platform.iam_person, platform.platform_students,
    // and tenant_X.sis_students. Wrapped in an interactive transaction so a failure on
    // any step rolls back the whole sequence — no orphan identity rows.
    var personId = generateId();
    var platformStudentId = generateId();
    var sisStudentId = generateId();

    try {
      return await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        // Pre-check student_number uniqueness inside the tx so we get a friendly 409
        // before paying for the platform-side inserts. A race after this point is
        // still caught by the unique constraint and surfaced as 409 below.
        var existing = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          'SELECT id FROM sis_students WHERE school_id = $1::uuid AND student_number = $2',
          schoolId,
          input.studentNumber,
        );
        if (existing.length > 0) {
          throw new ConflictException(
            'A student with number "' + input.studentNumber + '" already exists at this school',
          );
        }

        await tx.iamPerson.create({
          data: {
            id: personId,
            firstName: input.firstName,
            lastName: input.lastName,
            personType: 'STUDENT',
            isActive: true,
          },
        });
        await tx.platformStudent.create({
          data: {
            id: platformStudentId,
            personId: personId,
            firstName: input.firstName,
            lastName: input.lastName,
            isActive: true,
            dataSubjectIsSelf: false,
          },
        });
        await tx.$executeRawUnsafe(
          'INSERT INTO sis_students (id, platform_student_id, school_id, student_number, grade_level, homeroom_class_id, enrollment_status) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7)',
          sisStudentId,
          platformStudentId,
          schoolId,
          input.studentNumber,
          input.gradeLevel,
          input.homeroomClassId ?? null,
          'ENROLLED',
        );

        var rows = await tx.$queryRawUnsafe<StudentRow[]>(
          'SELECT s.id, s.student_number, s.grade_level, s.enrollment_status, ' +
            's.homeroom_class_id, s.school_id, s.platform_student_id, ' +
            'ip.id AS person_id, ip.first_name, ip.last_name ' +
            'FROM sis_students s ' +
            'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
            'JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
            'WHERE s.id = $1::uuid',
          sisStudentId,
        );
        return rowToDto(rows[0]!);
      });
    } catch (e: any) {
      // Translate the unique-constraint race (post-precheck) into a clean 409.
      var msg = e && typeof e.message === 'string' ? e.message : '';
      if (
        msg.indexOf('school_id, student_number') >= 0 ||
        msg.indexOf('sis_students_school_number_uq') >= 0
      ) {
        throw new ConflictException(
          'A student with number "' + input.studentNumber + '" already exists at this school',
        );
      }
      throw e;
    }
  }

  async update(
    id: string,
    input: UpdateStudentDto,
    actor: ResolvedActor,
  ): Promise<StudentResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school administrators can update student records');
    }
    var sets: string[] = [];
    var params: any[] = [];
    var i = 1;

    if (input.studentNumber !== undefined) {
      sets.push('student_number = $' + i++);
      params.push(input.studentNumber);
    }
    if (input.gradeLevel !== undefined) {
      sets.push('grade_level = $' + i++);
      params.push(input.gradeLevel);
    }
    if (input.homeroomClassId !== undefined) {
      sets.push('homeroom_class_id = $' + i++ + '::uuid');
      params.push(input.homeroomClassId);
    }
    if (input.enrollmentStatus !== undefined) {
      sets.push('enrollment_status = $' + i++);
      params.push(input.enrollmentStatus);
    }

    if (sets.length === 0) {
      throw new BadRequestException('No fields to update');
    }
    sets.push('updated_at = now()');

    params.push(id);
    var tenant = getCurrentTenant();
    params.push(tenant.schoolId);
    var sql =
      'UPDATE sis_students SET ' +
      sets.join(', ') +
      ' WHERE id = $' +
      i +
      '::uuid AND school_id = $' +
      (i + 1) +
      '::uuid';

    var affected = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(sql, ...params);
    });
    if (affected === 0) throw new NotFoundException('Student ' + id + ' not found');

    // Auto-alumni: persona-registration Step 14 (Section 4 of the
    // design). The student.update endpoint is the only path that flips
    // enrollment_status to GRADUATED in the codebase today (no
    // sis.student.graduated Kafka event exists yet), so we hook the
    // alumni-profile creation + persona-cache refresh inline. Failures
    // here are swallowed — graduation succeeds even if alumni
    // activation hits an unrelated snag; the next /auth/me call can
    // re-resolve.
    if (input.enrollmentStatus === 'GRADUATED') {
      await this.activateAlumniPersonaSafe(id);
    }

    return this.getById(id, actor);
  }

  /**
   * Idempotent upsert into alm_alumni_profiles + persona cache
   * refresh for the graduated student. ON CONFLICT (school_id,
   * person_id) DO NOTHING means a re-graduation (e.g. accidental
   * status flip back-and-forth) does not duplicate the row. The
   * graduation_year column is NOT NULL on alm_alumni_profiles and
   * sis_students doesn't carry one — we use the current UTC year as
   * a sensible default; a richer "expected graduation year" capture
   * lands when the SIS gains a graduation_year column.
   */
  private async activateAlumniPersonaSafe(studentId: string): Promise<void> {
    try {
      const personId = await this.tenantPrisma.executeInTenantContext(async (tx) => {
        const studentRows = await tx.$queryRawUnsafe<
          Array<{ school_id: string; platform_student_id: string }>
        >(
          'SELECT school_id::text AS school_id, platform_student_id::text AS platform_student_id ' +
            'FROM sis_students WHERE id = $1::uuid LIMIT 1',
          studentId,
        );
        if (studentRows.length === 0) return null;
        const schoolId = studentRows[0]!.school_id;
        const platformStudentId = studentRows[0]!.platform_student_id;
        const platformStudent = await tx.$queryRawUnsafe<Array<{ person_id: string }>>(
          'SELECT person_id::text AS person_id FROM platform.platform_students WHERE id = $1::uuid LIMIT 1',
          platformStudentId,
        );
        if (platformStudent.length === 0) return null;
        const personId = platformStudent[0]!.person_id;

        const gradYear = new Date().getUTCFullYear();
        await tx.$executeRawUnsafe(
          `INSERT INTO alm_alumni_profiles
             (id, school_id, person_id, graduation_year, is_opted_in)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::int, true)
           ON CONFLICT (school_id, person_id) DO NOTHING`,
          generateId(),
          schoolId,
          personId,
          gradYear,
        );
        return personId;
      });
      if (personId && this.personaResolution) {
        await this.personaResolution.refreshPersonaCache(personId);
      }
    } catch (err: any) {
      this.logger.warn(
        '[student.activateAlumniPersona] failed for student=' +
          studentId +
          ': ' +
          (err?.message ?? err),
      );
    }
  }
}
