import {
  BadRequestException,
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
  type CoursePrerequisiteDto,
  type CreateCoursePrerequisiteDto,
  type ValidateCourseRegistrationResponseDto,
} from './dto/sis-graduation.dto';

interface PrereqRow {
  id: string;
  course_id: string;
  prerequisite_course_id: string;
  is_mandatory: boolean;
  min_grade: string | null;
  prerequisite_course_code: string | null;
  prerequisite_course_name: string | null;
}

// Per-letter rank — A > B > C > D > F, used to compare student best-grade
// against the prerequisite's min_grade.
const GRADE_RANK: Record<string, number> = {
  'A+': 12,
  A: 11,
  'A-': 10,
  'B+': 9,
  B: 8,
  'B-': 7,
  'C+': 6,
  C: 5,
  'C-': 4,
  'D+': 3,
  D: 2,
  'D-': 1,
  F: 0,
};

/**
 * PrerequisiteService — CRUD for sis_course_prerequisites + a
 * validateRegistration endpoint that the course-enrolment flow can hit
 * to confirm a student has met every mandatory prerequisite with at
 * least min_grade before being enrolled.
 */
@Injectable()
export class PrerequisiteService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  private rowToDto(r: PrereqRow): CoursePrerequisiteDto {
    return {
      id: r.id,
      courseId: r.course_id,
      prerequisiteCourseId: r.prerequisite_course_id,
      isMandatory: r.is_mandatory,
      minGrade: r.min_grade,
      prerequisiteCourseCode: r.prerequisite_course_code,
      prerequisiteCourseName: r.prerequisite_course_name,
    };
  }

  private async assertAdmin(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'stu-005:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException('Only admins can manage course prerequisites.');
    }
  }

  async listForCourse(courseId: string): Promise<CoursePrerequisiteDto[]> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<PrereqRow[]>(
        'SELECT p.id::text, p.course_id::text, p.prerequisite_course_id::text, ' +
          'p.is_mandatory, p.min_grade, co.code AS prerequisite_course_code, co.name AS prerequisite_course_name ' +
          'FROM sis_course_prerequisites p ' +
          'JOIN sis_courses co ON co.id = p.prerequisite_course_id ' +
          'WHERE p.course_id = $1::uuid ORDER BY co.code',
        courseId,
      ),
    );
    return rows.map((r) => this.rowToDto(r));
  }

  async create(
    dto: CreateCoursePrerequisiteDto,
    actor: ResolvedActor,
  ): Promise<CoursePrerequisiteDto> {
    await this.assertAdmin(actor);
    if (dto.courseId === dto.prerequisiteCourseId) {
      throw new BadRequestException('A course cannot be its own prerequisite');
    }
    if (dto.minGrade && !(dto.minGrade in GRADE_RANK)) {
      throw new BadRequestException(
        'minGrade must be one of ' + Object.keys(GRADE_RANK).join(', '),
      );
    }
    // Validate both courses exist in this tenant.
    const tenant = getCurrentTenant();
    const courseRows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id::text FROM sis_courses WHERE id IN ($1::uuid, $2::uuid) AND school_id = $3::uuid',
        dto.courseId,
        dto.prerequisiteCourseId,
        tenant.schoolId,
      ),
    );
    if (courseRows.length !== 2) {
      throw new BadRequestException(
        'courseId and prerequisiteCourseId must both reference courses in this school',
      );
    }
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) =>
        client.$executeRawUnsafe(
          'INSERT INTO sis_course_prerequisites (id, course_id, prerequisite_course_id, is_mandatory, min_grade) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)',
          id,
          dto.courseId,
          dto.prerequisiteCourseId,
          dto.isMandatory ?? true,
          dto.minGrade ?? null,
        ),
      );
    } catch (err) {
      if (err instanceof Error && /sis_course_prereq_unique|unique constraint/i.test(err.message)) {
        throw new BadRequestException('This prerequisite already exists for the supplied course');
      }
      throw err;
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<PrereqRow[]>(
        'SELECT p.id::text, p.course_id::text, p.prerequisite_course_id::text, ' +
          'p.is_mandatory, p.min_grade, co.code AS prerequisite_course_code, co.name AS prerequisite_course_name ' +
          'FROM sis_course_prerequisites p ' +
          'JOIN sis_courses co ON co.id = p.prerequisite_course_id ' +
          'WHERE p.id = $1::uuid',
        id,
      ),
    );
    if (rows.length === 0) throw new NotFoundException('Prerequisite not found post-insert');
    return this.rowToDto(rows[0]!);
  }

  async delete(id: string, actor: ResolvedActor): Promise<void> {
    await this.assertAdmin(actor);
    await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$executeRawUnsafe('DELETE FROM sis_course_prerequisites WHERE id = $1::uuid', id),
    );
  }

  /**
   * Validate a student against every prerequisite for a course.
   *
   * Returns ok=true when:
   *   - No prerequisites configured for the course, OR
   *   - Every mandatory prerequisite has been completed AND every
   *     min_grade constraint is met.
   *
   * Non-mandatory prereqs that fail land in `warnings`; mandatory
   * failures land in `unmetPrerequisites` and force ok=false.
   *
   * Best-grade resolution: looks up the highest published grade for
   * the student on any cls_assignment in any class of the prerequisite
   * course. Uses sis_grade_scale_entries (Standard scale) to convert
   * the numeric grade to a letter when the cls_grades.letter_grade
   * column is null.
   */
  async validateRegistration(
    studentId: string,
    courseId: string,
  ): Promise<ValidateCourseRegistrationResponseDto> {
    const tenant = getCurrentTenant();
    // Validate the student exists in this tenant.
    const studentRows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        studentId,
        tenant.schoolId,
      ),
    );
    if (studentRows.length === 0) {
      throw new BadRequestException('studentId does not match a student in this school');
    }
    const prereqs = await this.listForCourse(courseId);
    if (prereqs.length === 0) {
      return { ok: true, unmetPrerequisites: [], warnings: [] };
    }

    // Pre-load the Standard scale once for letter resolution.
    const scale = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<
        Array<{
          letter_grade: string;
          min_percentage: string | null;
          max_percentage: string | null;
        }>
      >(
        'SELECT letter_grade, min_percentage::text, max_percentage::text ' +
          "FROM sis_grade_scale_entries WHERE school_id = $1::uuid AND scale_name = 'Standard' " +
          'ORDER BY sort_order',
        tenant.schoolId,
      ),
    );

    const unmet: string[] = [];
    const warnings: string[] = [];
    for (const prereq of prereqs) {
      const bestRows = await this.tenantPrisma.executeInTenantContext(async (client) =>
        client.$queryRawUnsafe<Array<{ best: string | null; letter: string | null }>>(
          'SELECT MAX(g.grade_value)::text AS best, MAX(g.letter_grade) AS letter ' +
            'FROM cls_grades g ' +
            'JOIN cls_assignments a ON a.id = g.assignment_id ' +
            'JOIN sis_classes c ON c.id = a.class_id ' +
            'WHERE g.student_id = $1::uuid AND c.course_id = $2::uuid AND g.is_published = true',
          studentId,
          prereq.prerequisiteCourseId,
        ),
      );
      const bestNum =
        bestRows[0]?.best === null || bestRows[0]?.best === undefined
          ? null
          : Number(bestRows[0]!.best);
      const explicitLetter = bestRows[0]?.letter ?? null;
      const message =
        (prereq.prerequisiteCourseName ?? 'Prerequisite course') +
        ' (' +
        (prereq.prerequisiteCourseCode ?? '—') +
        ')';

      if (bestNum === null) {
        const note = message + ' not completed.';
        if (prereq.isMandatory) unmet.push(note);
        else warnings.push(note);
        continue;
      }
      const studentLetter = explicitLetter ?? this.percentageToLetter(bestNum, scale);
      // Pass: any non-F grade. If a min_grade is set, also enforce that.
      if (bestNum < 60) {
        const note = message + ' attempted but not passed (grade ' + bestNum.toFixed(1) + ').';
        if (prereq.isMandatory) unmet.push(note);
        else warnings.push(note);
        continue;
      }
      if (prereq.minGrade) {
        const studentRank = GRADE_RANK[studentLetter] ?? 0;
        const requiredRank = GRADE_RANK[prereq.minGrade] ?? 0;
        if (studentRank < requiredRank) {
          const note =
            message +
            ' requires minimum grade ' +
            prereq.minGrade +
            ' (student earned ' +
            studentLetter +
            ').';
          if (prereq.isMandatory) unmet.push(note);
          else warnings.push(note);
        }
      }
    }
    return {
      ok: unmet.length === 0,
      unmetPrerequisites: unmet,
      warnings,
    };
  }

  private percentageToLetter(
    percentage: number,
    scale: Array<{
      letter_grade: string;
      min_percentage: string | null;
      max_percentage: string | null;
    }>,
  ): string {
    for (const entry of scale) {
      const min = entry.min_percentage === null ? 0 : Number(entry.min_percentage);
      const max = entry.max_percentage === null ? 100 : Number(entry.max_percentage);
      if (percentage >= min && percentage <= max) return entry.letter_grade;
    }
    return 'F';
  }
}
