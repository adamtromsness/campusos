import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import { PermissionCheckService } from '@modules/m00-platform';
import type { ResolvedActor } from '@modules/m00-platform';
import {
  GRADUATION_REQUIREMENT_TYPES,
  type CreateGraduationRequirementDto,
  type GraduationAuditDto,
  type GraduationAuditStatus,
  type GraduationAuditSummaryDto,
  type GraduationRequirementDto,
  type GraduationRequirementType,
  type UpdateGraduationRequirementDto,
} from './dto/sis-graduation.dto';

interface RequirementRow {
  id: string;
  school_id: string;
  requirement_type: string;
  requirement_name: string;
  subject_area: string | null;
  credits_required: string | null;
  specific_course_id: string | null;
  hours_required: number | null;
  assessment_name: string | null;
  minimum_gpa: string | null;
  applies_to_grade_levels: string[];
  is_active: boolean;
}

interface AuditRow {
  id: string;
  student_id: string;
  requirement_id: string;
  status: string;
  credits_earned: string | null;
  credits_remaining: string | null;
  detail: string | null;
  last_calculated: string;
}

/**
 * Graduation Service — CRUD for sis_graduation_requirements and read
 * paths over sis_student_graduation_audits.
 *
 * Permission model:
 *   - Write (create / patch / delete) requirements: actor.isSchoolAdmin
 *     OR stu-005:admin. Service-layer narrows admin writes.
 *   - Read audits: row-scoped to admin (all), STAFF (read for advising
 *     students they teach — service narrows by `actor.employeeId` via
 *     sis_class_teachers + sis_enrollments), STUDENT (own only), GUARDIAN
 *     (linked children via sis_student_guardians).
 *
 * GraduationAuditWorker is the sole writer to sis_student_graduation_audits;
 * the request path only exposes read endpoints + a manual `runAuditForStudent`
 * trigger gated on actor.isSchoolAdmin.
 */
@Injectable()
export class GraduationService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  // ─── Helpers ───

  private rowToDto(r: RequirementRow): GraduationRequirementDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      requirementType: r.requirement_type as GraduationRequirementType,
      requirementName: r.requirement_name,
      subjectArea: r.subject_area,
      creditsRequired: r.credits_required === null ? null : Number(r.credits_required),
      specificCourseId: r.specific_course_id,
      hoursRequired: r.hours_required,
      assessmentName: r.assessment_name,
      minimumGpa: r.minimum_gpa === null ? null : Number(r.minimum_gpa),
      appliesToGradeLevels: r.applies_to_grade_levels ?? [],
      isActive: r.is_active,
    };
  }

  private auditRowToDto(r: AuditRow): GraduationAuditDto {
    return {
      id: r.id,
      studentId: r.student_id,
      requirementId: r.requirement_id,
      status: r.status as GraduationAuditStatus,
      creditsEarned: r.credits_earned === null ? null : Number(r.credits_earned),
      creditsRemaining: r.credits_remaining === null ? null : Number(r.credits_remaining),
      detail: r.detail,
      lastCalculated: r.last_calculated,
    };
  }

  /**
   * Admin check — actor.isSchoolAdmin OR stu-005:admin. Used by every
   * write path for requirements + the manual single-student audit trigger.
   */
  private async assertAdmin(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'stu-005:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException('Only admins can manage graduation requirements.');
    }
  }

  /**
   * Validate the requirement shape — multi-column shape_chk at the
   * schema layer is the belt-and-braces. Service layer surfaces a
   * friendly 400 before the INSERT lands.
   */
  private validateRequirementShape(input: {
    requirementType: GraduationRequirementType;
    subjectArea?: string | null;
    creditsRequired?: number | null;
    specificCourseId?: string | null;
    hoursRequired?: number | null;
    assessmentName?: string | null;
    minimumGpa?: number | null;
  }): void {
    if (!GRADUATION_REQUIREMENT_TYPES.includes(input.requirementType)) {
      throw new BadRequestException(
        'requirementType must be one of ' + GRADUATION_REQUIREMENT_TYPES.join(', '),
      );
    }
    switch (input.requirementType) {
      case 'CREDIT_TOTAL':
        if (input.creditsRequired === undefined || input.creditsRequired === null) {
          throw new BadRequestException('CREDIT_TOTAL requires creditsRequired');
        }
        break;
      case 'SUBJECT_CREDIT':
        if (!input.subjectArea) {
          throw new BadRequestException('SUBJECT_CREDIT requires subjectArea');
        }
        if (input.creditsRequired === undefined || input.creditsRequired === null) {
          throw new BadRequestException('SUBJECT_CREDIT requires creditsRequired');
        }
        break;
      case 'SPECIFIC_COURSE':
        if (!input.specificCourseId) {
          throw new BadRequestException('SPECIFIC_COURSE requires specificCourseId');
        }
        break;
      case 'SERVICE_HOURS':
        if (input.hoursRequired === undefined || input.hoursRequired === null) {
          throw new BadRequestException('SERVICE_HOURS requires hoursRequired');
        }
        break;
      case 'ASSESSMENT':
        if (!input.assessmentName) {
          throw new BadRequestException('ASSESSMENT requires assessmentName');
        }
        break;
      case 'MINIMUM_GPA':
        if (input.minimumGpa === undefined || input.minimumGpa === null) {
          throw new BadRequestException('MINIMUM_GPA requires minimumGpa');
        }
        break;
    }
  }

  /**
   * Verify the calling actor can read audits for the supplied student.
   *
   * REVIEW-P2C13 MAJOR 3 — generic STAFF no longer blanket-bypasses
   * row scope. STAFF must hold stu-005:write or stu-005:admin (the
   * registrar / counsellor / advisor signal — held in the IAM seed
   * by Staff alone) OR be an assigned class teacher of the student
   * (sis_class_teachers + sis_enrollments). GUARDIAN linkage joins
   * through sis_students.school_id so a parent in school A cannot
   * read an audit for a child in school B by UUID.
   */
  private async assertCanReadStudent(studentId: string, actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STAFF') {
      const tenant = getCurrentTenant();
      // Registrar / advisor scope — explicit permission check.
      const advisor = await this.permissions.hasAnyPermissionInTenant(
        actor.accountId,
        tenant.schoolId,
        ['stu-005:write', 'stu-005:admin'],
      );
      if (advisor) return;
      // Teacher of the student via class assignment.
      if (actor.employeeId) {
        const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
          client.$queryRawUnsafe<Array<{ ok: number }>>(
            'SELECT 1 AS ok FROM sis_class_teachers ct ' +
              'JOIN sis_enrollments en ON en.class_id = ct.class_id ' +
              'JOIN sis_classes c ON c.id = ct.class_id ' +
              'WHERE ct.teacher_employee_id = $1::uuid AND en.student_id = $2::uuid ' +
              "AND en.status = 'ACTIVE' AND c.school_id = $3::uuid LIMIT 1",
            actor.employeeId,
            studentId,
            tenant.schoolId,
          ),
        );
        if (rows.length > 0) return;
      }
      throw new NotFoundException('Student not found');
    }
    if (actor.personType === 'STUDENT') {
      const ownId = await this.resolveOwnStudentId(actor);
      if (ownId === studentId) return;
      throw new NotFoundException('Student not found');
    }
    if (actor.personType === 'GUARDIAN') {
      const tenant = getCurrentTenant();
      const linked = await this.tenantPrisma.executeInTenantContext(async (client) =>
        client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_student_guardians sg ' +
            'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            'JOIN sis_students s ON s.id = sg.student_id ' +
            'WHERE sg.student_id = $1::uuid AND g.person_id = $2::uuid ' +
            'AND s.school_id = $3::uuid LIMIT 1',
          studentId,
          actor.personId,
          tenant.schoolId,
        ),
      );
      if (linked.length > 0) return;
      throw new NotFoundException('Student not found');
    }
    throw new NotFoundException('Student not found');
  }

  private async resolveOwnStudentId(actor: ResolvedActor): Promise<string | null> {
    if (actor.personType !== 'STUDENT') return null;
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = await client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT s.id::text AS id FROM sis_students s ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'WHERE s.school_id = $1::uuid AND ps.person_id = $2::uuid LIMIT 1',
        tenant.schoolId,
        actor.personId,
      );
      return rows[0]?.id ?? null;
    });
  }

  // ─── Requirements CRUD ───

  async listRequirements(
    args: { includeInactive?: boolean } = {},
  ): Promise<GraduationRequirementDto[]> {
    const tenant = getCurrentTenant();
    let sql =
      'SELECT id::text, school_id::text, requirement_type, requirement_name, subject_area, ' +
      'credits_required::text, specific_course_id::text, hours_required, assessment_name, ' +
      'minimum_gpa::text, applies_to_grade_levels, is_active ' +
      'FROM sis_graduation_requirements WHERE school_id = $1::uuid';
    if (!args.includeInactive) {
      sql += ' AND is_active = true';
    }
    sql += ' ORDER BY requirement_type, requirement_name';
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<RequirementRow[]>(sql, tenant.schoolId),
    );
    return rows.map((r) => this.rowToDto(r));
  }

  async getRequirement(id: string): Promise<GraduationRequirementDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<RequirementRow[]>(
        'SELECT id::text, school_id::text, requirement_type, requirement_name, subject_area, ' +
          'credits_required::text, specific_course_id::text, hours_required, assessment_name, ' +
          'minimum_gpa::text, applies_to_grade_levels, is_active ' +
          'FROM sis_graduation_requirements WHERE id = $1::uuid AND school_id = $2::uuid',
        id,
        tenant.schoolId,
      ),
    );
    if (rows.length === 0) throw new NotFoundException('Graduation requirement not found');
    return this.rowToDto(rows[0]!);
  }

  async createRequirement(
    dto: CreateGraduationRequirementDto,
    actor: ResolvedActor,
  ): Promise<GraduationRequirementDto> {
    await this.assertAdmin(actor);
    this.validateRequirementShape(dto);
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$executeRawUnsafe(
        'INSERT INTO sis_graduation_requirements ' +
          '(id, school_id, requirement_type, requirement_name, subject_area, credits_required, ' +
          'specific_course_id, hours_required, assessment_name, minimum_gpa, applies_to_grade_levels) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, $8, $9, $10, $11::text[])',
        id,
        tenant.schoolId,
        dto.requirementType,
        dto.requirementName,
        dto.subjectArea ?? null,
        dto.creditsRequired ?? null,
        dto.specificCourseId ?? null,
        dto.hoursRequired ?? null,
        dto.assessmentName ?? null,
        dto.minimumGpa ?? null,
        dto.appliesToGradeLevels ?? [],
      ),
    );
    return this.getRequirement(id);
  }

  async patchRequirement(
    id: string,
    dto: UpdateGraduationRequirementDto,
    actor: ResolvedActor,
  ): Promise<GraduationRequirementDto> {
    await this.assertAdmin(actor);
    // Load existing for shape re-validation under partial patch.
    const existing = await this.getRequirement(id);
    this.validateRequirementShape({
      requirementType: existing.requirementType,
      subjectArea: dto.subjectArea ?? existing.subjectArea,
      creditsRequired: dto.creditsRequired ?? existing.creditsRequired,
      specificCourseId: dto.specificCourseId ?? existing.specificCourseId,
      hoursRequired: dto.hoursRequired ?? existing.hoursRequired,
      assessmentName: dto.assessmentName ?? existing.assessmentName,
      minimumGpa: dto.minimumGpa ?? existing.minimumGpa,
    });

    const sets: string[] = [];
    const params: unknown[] = [];
    let n = 1;
    const add = (col: string, val: unknown, cast?: string): void => {
      sets.push(col + ' = $' + n + (cast ? '::' + cast : ''));
      params.push(val);
      n += 1;
    };
    if (dto.requirementName !== undefined) add('requirement_name', dto.requirementName);
    if (dto.subjectArea !== undefined) add('subject_area', dto.subjectArea);
    if (dto.creditsRequired !== undefined) add('credits_required', dto.creditsRequired);
    if (dto.specificCourseId !== undefined) add('specific_course_id', dto.specificCourseId, 'uuid');
    if (dto.hoursRequired !== undefined) add('hours_required', dto.hoursRequired);
    if (dto.assessmentName !== undefined) add('assessment_name', dto.assessmentName);
    if (dto.minimumGpa !== undefined) add('minimum_gpa', dto.minimumGpa);
    if (dto.appliesToGradeLevels !== undefined)
      add('applies_to_grade_levels', dto.appliesToGradeLevels, 'text[]');
    if (dto.isActive !== undefined) add('is_active', dto.isActive);
    if (sets.length === 0) return existing;
    sets.push('updated_at = now()');
    params.push(id);
    await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$executeRawUnsafe(
        'UPDATE sis_graduation_requirements SET ' +
          sets.join(', ') +
          ' WHERE id = $' +
          n +
          '::uuid',
        ...params,
      ),
    );
    return this.getRequirement(id);
  }

  async deleteRequirement(id: string, actor: ResolvedActor): Promise<void> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$executeRawUnsafe(
        'DELETE FROM sis_graduation_requirements WHERE id = $1::uuid AND school_id = $2::uuid',
        id,
        tenant.schoolId,
      ),
    );
  }

  // ─── Audits ───

  async getAuditForStudent(
    studentId: string,
    actor: ResolvedActor,
  ): Promise<GraduationAuditSummaryDto> {
    await this.assertCanReadStudent(studentId, actor);
    const tenant = getCurrentTenant();

    // Ensure the student belongs to this school first.
    const studentRows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        studentId,
        tenant.schoolId,
      ),
    );
    if (studentRows.length === 0) throw new NotFoundException('Student not found');

    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<AuditRow[]>(
        'SELECT a.id::text, a.student_id::text, a.requirement_id::text, a.status, ' +
          'a.credits_earned::text, a.credits_remaining::text, a.detail, a.last_calculated::text ' +
          'FROM sis_student_graduation_audits a ' +
          'JOIN sis_graduation_requirements r ON r.id = a.requirement_id ' +
          'WHERE a.student_id = $1::uuid AND r.school_id = $2::uuid ' +
          'ORDER BY r.requirement_type, r.requirement_name',
        studentId,
        tenant.schoolId,
      ),
    );
    const audits = rows.map((r) => this.auditRowToDto(r));
    const metCount = audits.filter((a) => a.status === 'MET').length;
    const inProgressCount = audits.filter((a) => a.status === 'IN_PROGRESS').length;
    const notMetCount = audits.filter((a) => a.status === 'NOT_MET').length;
    return {
      studentId,
      audits,
      metCount,
      inProgressCount,
      notMetCount,
      isAtRisk: notMetCount > 0,
    };
  }

  /**
   * School-wide at-risk list — every student with ANY NOT_MET audit
   * row. Admin / stu-005:read writers only. Hits the partial INDEX
   * `sis_grad_audit_not_met_idx`.
   */
  async listAtRiskStudents(actor: ResolvedActor): Promise<
    Array<{
      studentId: string;
      studentName: string | null;
      gradeLevel: string | null;
      notMetCount: number;
    }>
  > {
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException('Only school staff and admins can view the at-risk list.');
    }
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<
        Array<{
          student_id: string;
          first_name: string | null;
          last_name: string | null;
          grade_level: string | null;
          not_met_count: number;
        }>
      >(
        'SELECT a.student_id::text AS student_id, ip.first_name, ip.last_name, s.grade_level, ' +
          'COUNT(*)::int AS not_met_count ' +
          'FROM sis_student_graduation_audits a ' +
          'JOIN sis_students s ON s.id = a.student_id ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
          "WHERE a.status = 'NOT_MET' AND s.school_id = $1::uuid " +
          'GROUP BY a.student_id, ip.first_name, ip.last_name, s.grade_level ' +
          'ORDER BY not_met_count DESC, last_name, first_name',
        tenant.schoolId,
      ),
    );
    return rows.map((r) => ({
      studentId: r.student_id,
      studentName:
        r.first_name || r.last_name
          ? ((r.first_name ?? '') + ' ' + (r.last_name ?? '')).trim()
          : null,
      gradeLevel: r.grade_level,
      notMetCount: Number(r.not_met_count),
    }));
  }
}
