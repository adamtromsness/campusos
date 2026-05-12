import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
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
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private assertAdminOrStaff(actor: ResolvedActor): void {
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException(
        'Subject choice administration requires school admin or STAFF persona.',
      );
    }
  }

  /**
   * Resolve the calling student's sis_students.id. Used to row-scope
   * STUDENT actors. Returns null when no projection exists.
   */
  private async resolveOwnStudentId(personId: string): Promise<string | null> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = await client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT s.id::text AS id FROM sis_students s ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'WHERE ps.person_id = $1::uuid LIMIT 1',
        personId,
      );
      return rows[0]?.id ?? null;
    });
  }

  /**
   * Resolve the guardian's linked sis_students.id list.
   */
  private async resolveGuardianStudentIds(personId: string): Promise<string[]> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = await client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT DISTINCT s.id::text AS id FROM sis_students s ' +
          'JOIN sis_student_guardians sg ON sg.student_id = s.id ' +
          'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
          'WHERE g.person_id = $1::uuid',
        personId,
      );
      return rows.map((r) => r.id);
    });
  }

  async list(
    actor: ResolvedActor,
    filters: { studentId?: string; academicYearId?: string; courseId?: string },
  ): Promise<SubjectChoiceResponseDto[]> {
    // Build the row-scope predicate.
    const params: unknown[] = [];
    const conds: string[] = [];
    let p = 1;
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
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
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
        // Other persona types — no rows.
        return [];
      }
    }
    const where = conds.length === 0 ? '' : 'WHERE ' + conds.join(' AND ') + ' ';
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
    // Validate the student belongs to the calling actor (admin override allowed).
    if (!actor.isSchoolAdmin) {
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
      } else if (actor.personType !== 'STAFF') {
        throw new ForbiddenException(
          'Subject choice submission requires student / guardian / staff / admin.',
        );
      }
    }

    // Validate an open window exists if the caller isn't an admin or staff.
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      const tenant = getCurrentTenant();
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
   * academic year. Admin / STAFF only.
   */
  async demand(academicYearId: string, actor: ResolvedActor): Promise<SubjectChoiceDemandRowDto[]> {
    this.assertAdminOrStaff(actor);
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
          'WHERE sc.academic_year_id = $1::uuid ' +
          'GROUP BY co.id, co.name ' +
          'ORDER BY total_students DESC, co.name ASC',
        academicYearId,
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
    this.assertAdminOrStaff(actor);
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
