import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import {
  CreateSubjectChoiceWindowDto,
  SubjectChoiceDemandRowDto,
  SubjectChoiceResponseDto,
  SubjectChoiceWindowResponseDto,
  SubmitSubjectChoiceDto,
} from './dto/scheduling-advanced.dto';

/*
 * SubjectChoiceService — P2-17a Step 2.
 *
 * Owns sch_student_subject_choices + sch_subject_choice_windows.
 * Students submit during the active window; admins read demand matrix
 * + manage windows. Service-layer row scope:
 *   - admin / STAFF — see all
 *   - GUARDIAN — see own children
 *   - STUDENT — see own
 *   - else — no rows
 */

interface ChoiceRow {
  id: string;
  student_id: string;
  academic_year_id: string;
  course_id: string;
  course_name: string | null;
  preference_rank: number | null;
  is_required: boolean;
  submitted_at: string | null;
  notes: string | null;
}

interface WindowRow {
  id: string;
  school_id: string;
  academic_year_id: string | null;
  name: string | null;
  opens_at: string;
  closes_at: string;
  target_grade_levels: string[] | null;
  is_active: boolean;
  description: string | null;
}

function choiceRowToDto(row: ChoiceRow): SubjectChoiceResponseDto {
  return {
    id: row.id,
    studentId: row.student_id,
    academicYearId: row.academic_year_id,
    courseId: row.course_id,
    courseName: row.course_name,
    preferenceRank: row.preference_rank,
    isRequired: row.is_required,
    submittedAt: row.submitted_at,
    notes: row.notes,
  };
}

function windowRowToDto(row: WindowRow): SubjectChoiceWindowResponseDto {
  return {
    id: row.id,
    schoolId: row.school_id,
    academicYearId: row.academic_year_id,
    name: row.name,
    opensAt: row.opens_at,
    closesAt: row.closes_at,
    targetGradeLevels: row.target_grade_levels,
    isActive: row.is_active,
    description: row.description,
  };
}

const SELECT_CHOICE_BASE =
  'SELECT sc.id::text AS id, sc.student_id::text AS student_id, ' +
  'sc.academic_year_id::text AS academic_year_id, sc.course_id::text AS course_id, ' +
  'co.name AS course_name, sc.preference_rank, sc.is_required, ' +
  'TO_CHAR(sc.submitted_at, \'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') AS submitted_at, sc.notes ' +
  'FROM sch_student_subject_choices sc ' +
  // REVIEW-P2C17 BLOCKING 7 — INNER JOIN sis_students so every read
  // is implicitly school-scoped through stu.school_id. Cross-school
  // student_id values land on rows without a join match and drop out.
  'JOIN sis_students stu ON stu.id = sc.student_id ' +
  'LEFT JOIN sis_courses co ON co.id = sc.course_id ';

const SELECT_WINDOW_BASE =
  'SELECT id::text AS id, school_id::text AS school_id, ' +
  'academic_year_id::text AS academic_year_id, name, ' +
  'TO_CHAR(opens_at, \'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') AS opens_at, ' +
  'TO_CHAR(closes_at, \'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') AS closes_at, ' +
  'target_grade_levels, is_active, description ' +
  'FROM sch_subject_choice_windows ';

@Injectable()
export class SubjectChoiceService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissionCheck: PermissionCheckService,
  ) {}

  /**
   * REVIEW-P2C17 BLOCKING 7 — replaces the prior `personType === 'STAFF'`
   * bypass. Admin permissions live behind explicit sch-001:admin (the
   * scheduling-admin tier) rather than a raw persona-type check. A
   * generic STAFF user with sch-001:read no longer reaches admin-only
   * paths (demand matrix, window creation, broad-row reads, on-behalf
   * submission for arbitrary students).
   */
  private async hasSchedulingAdminScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissionCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'sch-001:admin',
    ]);
  }

  private async assertSchedulingAdmin(actor: ResolvedActor): Promise<void> {
    if (!(await this.hasSchedulingAdminScope(actor))) {
      throw new ForbiddenException(
        'Subject choice administration requires school admin or sch-001:admin.',
      );
    }
  }

  /**
   * Resolve the calling student's sis_students.id. Used to row-scope
   * STUDENT actors. REVIEW-P2C17 BLOCKING 7 — school-scoped through
   * sis_students.school_id so a student whose iam_person carries a
   * cross-school projection cannot leak into this tenant. Returns
   * null when no projection exists IN THE CURRENT SCHOOL.
   */
  private async resolveOwnStudentId(personId: string): Promise<string | null> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = await client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT s.id::text AS id FROM sis_students s ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'WHERE ps.person_id = $1::uuid AND s.school_id = $2::uuid LIMIT 1',
        personId,
        tenant.schoolId,
      );
      return rows[0]?.id ?? null;
    });
  }

  /**
   * Resolve the guardian's linked sis_students.id list — only students
   * IN THE CURRENT SCHOOL. REVIEW-P2C17 BLOCKING 7.
   */
  private async resolveGuardianStudentIds(personId: string): Promise<string[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = await client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT DISTINCT s.id::text AS id FROM sis_students s ' +
          'JOIN sis_student_guardians sg ON sg.student_id = s.id ' +
          'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
          'WHERE g.person_id = $1::uuid AND s.school_id = $2::uuid',
        personId,
        tenant.schoolId,
      );
      return rows.map((r) => r.id);
    });
  }

  async list(
    actor: ResolvedActor,
    filters: { studentId?: string; academicYearId?: string; courseId?: string },
  ): Promise<SubjectChoiceResponseDto[]> {
    // REVIEW-P2C17 BLOCKING 7 — school-scope every read through
    // sis_students.school_id (SELECT_CHOICE_BASE JOINs sis_students
    // stu) plus actor row scope. Admin path keeps the full school
    // catalogue. Non-admin STAFF + every other persona row-scope
    // through their own / linked students. Generic STAFF without
    // sch-001:admin no longer sees every student's choices.
    const tenant = getCurrentTenant();
    const params: unknown[] = [tenant.schoolId];
    const conds: string[] = ['stu.school_id = $1::uuid'];
    let p = 2;
    if (filters.studentId) {
      conds.push('sc.student_id = $' + p + '::uuid');
      params.push(filters.studentId);
      p++;
    }
    if (filters.academicYearId) {
      conds.push('sc.academic_year_id = $' + p + '::uuid');
      params.push(filters.academicYearId);
      p++;
    }
    if (filters.courseId) {
      conds.push('sc.course_id = $' + p + '::uuid');
      params.push(filters.courseId);
      p++;
    }

    const isAdmin = await this.hasSchedulingAdminScope(actor);
    if (!isAdmin) {
      if (actor.personType === 'STUDENT') {
        const sid = await this.resolveOwnStudentId(actor.personId);
        if (!sid) return [];
        conds.push('sc.student_id = $' + p + '::uuid');
        params.push(sid);
        p++;
      } else if (actor.personType === 'GUARDIAN') {
        const ids = await this.resolveGuardianStudentIds(actor.personId);
        if (ids.length === 0) return [];
        const placeholders = ids
          .map(() => {
            const slot = '$' + p + '::uuid';
            p++;
            return slot;
          })
          .join(',');
        conds.push('sc.student_id IN (' + placeholders + ')');
        params.push(...ids);
      } else {
        // Non-admin non-student non-guardian (e.g. generic STAFF with
        // sch-001:read but no sch-001:admin) — no rows.
        return [];
      }
    }
    const where = 'WHERE ' + conds.join(' AND ') + ' ';
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ChoiceRow[]>(
        SELECT_CHOICE_BASE +
          where +
          'ORDER BY sc.academic_year_id, sc.student_id, sc.preference_rank NULLS LAST',
        ...params,
      );
    });
    return rows.map(choiceRowToDto);
  }

  async submit(
    body: SubmitSubjectChoiceDto,
    actor: ResolvedActor,
  ): Promise<SubjectChoiceResponseDto> {
    // REVIEW-P2C17 BLOCKING 7 — admin override flows through explicit
    // sch-001:admin (the scheduling-admin tier), not raw STAFF persona.
    const isAdmin = await this.hasSchedulingAdminScope(actor);
    const tenant = getCurrentTenant();

    // REVIEW-P2C17 BLOCKING 7 — validate that body.studentId belongs
    // to the current school regardless of actor type. Admin who
    // supplies a cross-school student now gets 400 BEFORE the insert.
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = await client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id::text AS id FROM sis_students WHERE id = $1::uuid AND school_id = $2::uuid',
        body.studentId,
        tenant.schoolId,
      );
      if (rows.length === 0) {
        throw new BadRequestException('studentId does not match a student in this school.');
      }
    });

    // Row-scope validation per actor type.
    if (!isAdmin) {
      if (actor.personType === 'STUDENT') {
        const sid = await this.resolveOwnStudentId(actor.personId);
        if (!sid) throw new ForbiddenException('Student record not found in this tenant.');
        if (sid !== body.studentId) {
          throw new ForbiddenException('Students can only submit choices for themselves.');
        }
      } else if (actor.personType === 'GUARDIAN') {
        const ids = await this.resolveGuardianStudentIds(actor.personId);
        if (!ids.includes(body.studentId)) {
          throw new ForbiddenException('Guardian can only submit for their own children.');
        }
      } else {
        throw new ForbiddenException(
          'Subject choice submission requires student / guardian / sch-001:admin.',
        );
      }
    }

    // Validate an open window exists for non-admin callers. Admin
    // override skips the window check (intentional — admins can land
    // late corrections).
    if (!isAdmin) {
      const open = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ id: string }>>(
          'SELECT id::text AS id FROM sch_subject_choice_windows ' +
            'WHERE school_id = $1::uuid AND academic_year_id = $2::uuid ' +
            'AND is_active = true AND opens_at <= now() AND closes_at >= now() LIMIT 1',
          tenant.schoolId,
          body.academicYearId,
        );
      });
      if (open.length === 0) {
        throw new BadRequestException(
          'No active subject choice window for this academic year — submissions are closed.',
        );
      }
    }

    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO sch_student_subject_choices (id, student_id, academic_year_id, course_id, preference_rank, is_required, submitted_at, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6, now(), $7)',
          id,
          body.studentId,
          body.academicYearId,
          body.courseId,
          body.preferenceRank ?? null,
          body.isRequired ?? false,
          body.notes ?? null,
        );
      });
    } catch (e: unknown) {
      const err = e as { code?: string; meta?: { code?: string } };
      if (err.code === 'P2010' || err.meta?.code === '23505') {
        throw new ConflictException(
          'This student has already submitted a choice for this (year, course) — PATCH to update.',
        );
      }
      throw e;
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ChoiceRow[]>(SELECT_CHOICE_BASE + 'WHERE sc.id = $1::uuid', id);
    });
    return choiceRowToDto(rows[0]!);
  }

  /**
   * Demand matrix — course × total students submitted for the supplied
   * academic year. REVIEW-P2C17 BLOCKING 7 — admin-only via the
   * sch-001:admin scope helper, and school-scoped by JOINing through
   * sis_students.school_id so cross-school choices on the same year
   * never blend into the report.
   */
  async demand(academicYearId: string, actor: ResolvedActor): Promise<SubjectChoiceDemandRowDto[]> {
    await this.assertSchedulingAdmin(actor);
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{
          course_id: string;
          course_name: string;
          total_students: bigint;
          required_count: bigint;
          ranked_first_count: bigint;
        }>
      >(
        'SELECT co.id::text AS course_id, co.name AS course_name, ' +
          'COUNT(DISTINCT sc.student_id)::bigint AS total_students, ' +
          'COUNT(*) FILTER (WHERE sc.is_required = true)::bigint AS required_count, ' +
          'COUNT(*) FILTER (WHERE sc.preference_rank = 1)::bigint AS ranked_first_count ' +
          'FROM sch_student_subject_choices sc ' +
          'JOIN sis_courses co ON co.id = sc.course_id ' +
          'JOIN sis_students stu ON stu.id = sc.student_id ' +
          'WHERE sc.academic_year_id = $1::uuid AND stu.school_id = $2::uuid ' +
          'GROUP BY co.id, co.name ' +
          'ORDER BY total_students DESC, co.name ASC',
        academicYearId,
        tenant.schoolId,
      );
    });
    return rows.map((r) => ({
      courseId: r.course_id,
      courseName: r.course_name,
      totalStudents: Number(r.total_students),
      requiredCount: Number(r.required_count),
      rankedFirstCount: Number(r.ranked_first_count),
    }));
  }

  async listWindows(): Promise<SubjectChoiceWindowResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<WindowRow[]>(
        SELECT_WINDOW_BASE + 'WHERE school_id = $1::uuid ORDER BY opens_at DESC',
        tenant.schoolId,
      );
    });
    return rows.map(windowRowToDto);
  }

  async createWindow(
    body: CreateSubjectChoiceWindowDto,
    actor: ResolvedActor,
  ): Promise<SubjectChoiceWindowResponseDto> {
    await this.assertSchedulingAdmin(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    if (new Date(body.closesAt) <= new Date(body.opensAt)) {
      throw new BadRequestException('closesAt must be after opensAt');
    }
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO sch_subject_choice_windows (id, school_id, academic_year_id, name, opens_at, closes_at, target_grade_levels, is_active, description) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz, $6::timestamptz, $7::text[], $8, $9)',
          id,
          tenant.schoolId,
          body.academicYearId ?? null,
          body.name ?? null,
          body.opensAt,
          body.closesAt,
          body.targetGradeLevels ?? null,
          body.isActive ?? true,
          body.description ?? null,
        );
      });
    } catch (e: unknown) {
      const err = e as { code?: string; meta?: { code?: string } };
      if (err.code === 'P2010' || err.meta?.code === '23505') {
        throw new ConflictException(
          'A subject choice window already exists for this (school, academic year).',
        );
      }
      throw e;
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<WindowRow[]>(SELECT_WINDOW_BASE + 'WHERE id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('Window not found after insert');
    return windowRowToDto(rows[0]!);
  }
}
