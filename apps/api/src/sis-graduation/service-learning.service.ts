import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { PermissionCheckService } from '../iam/permission-check.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  SERVICE_LEARNING_DEADLINE_TYPES,
  type CreateServiceLearningRequirementDto,
  type ReviewServiceLearningHoursDto,
  type ServiceHoursStatus,
  type ServiceLearningDeadlineType,
  type ServiceLearningHoursDto,
  type ServiceLearningProgressDto,
  type ServiceLearningRequirementDto,
  type SubmitServiceLearningHoursDto,
} from './dto/sis-graduation.dto';

interface RequirementRow {
  id: string;
  school_id: string;
  grade_level: string;
  required_hours: number;
  deadline_type: string;
  specific_deadline: string | null;
  is_active: boolean;
}

interface HoursRow {
  id: string;
  student_id: string;
  organisation_name: string;
  activity_description: string;
  hours: string;
  service_date: string;
  supervisor_name: string | null;
  supervisor_contact: string | null;
  evidence_s3_key: string | null;
  status: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  created_at: string;
}

/**
 * Service Learning Service.
 *
 * Permission model:
 *   - Submit hours: STUDENT (own only — service-layer row scope) OR
 *     STAFF / admin on behalf. Service narrows on actor.personType.
 *   - Review hours (APPROVE / REJECT): admin OR holds stu-005:write
 *     (Staff covers the registrar / counsellor).
 *   - Read hours: admin, STAFF (broad), STUDENT (own only via row scope),
 *     GUARDIAN (linked children via sis_student_guardians).
 *   - Requirement CRUD: admin only.
 */
@Injectable()
export class ServiceLearningService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  private reqRowToDto(r: RequirementRow): ServiceLearningRequirementDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      gradeLevel: r.grade_level,
      requiredHours: r.required_hours,
      deadlineType: r.deadline_type as ServiceLearningDeadlineType,
      specificDeadline: r.specific_deadline,
      isActive: r.is_active,
    };
  }

  private hoursRowToDto(r: HoursRow): ServiceLearningHoursDto {
    return {
      id: r.id,
      studentId: r.student_id,
      organisationName: r.organisation_name,
      activityDescription: r.activity_description,
      hours: Number(r.hours),
      serviceDate: r.service_date,
      supervisorName: r.supervisor_name,
      supervisorContact: r.supervisor_contact,
      evidenceS3Key: r.evidence_s3_key,
      status: r.status as ServiceHoursStatus,
      reviewedBy: r.reviewed_by,
      reviewedAt: r.reviewed_at,
      reviewNotes: r.review_notes,
      createdAt: r.created_at,
    };
  }

  private async assertAdmin(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'stu-005:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException('Only admins can manage service learning requirements.');
    }
  }

  private async assertReviewer(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'stu-005:write',
      'stu-005:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException('Only staff or admins can review service learning hours.');
    }
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

  /**
   * REVIEW-P2C13 BLOCKING 4 — replace blanket `STAFF` bypass with an
   * explicit registrar/advisor permission check. Staff must hold
   * stu-005:write or stu-005:admin (the registrar / counsellor signal
   * in the IAM seed). Generic staff no longer reach service-learning
   * surfaces by accident.
   */
  private async hasReviewerScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    if (actor.personType !== 'STAFF') return false;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'stu-005:write',
      'stu-005:admin',
    ]);
  }

  private async assertCanSubmitForStudent(studentId: string, actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STAFF') {
      if (await this.hasReviewerScope(actor)) return;
      throw new ForbiddenException(
        'Staff submitting service hours on behalf of a student must hold stu-005:write or stu-005:admin.',
      );
    }
    if (actor.personType === 'STUDENT') {
      const ownId = await this.resolveOwnStudentId(actor);
      if (ownId === studentId) return;
      throw new ForbiddenException('Students can only submit service hours for themselves.');
    }
    throw new ForbiddenException('Only students or staff can submit service learning hours.');
  }

  private async assertCanReadStudent(studentId: string, actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STAFF') {
      if (await this.hasReviewerScope(actor)) return;
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

  // ─── Requirements ───

  async listRequirements(): Promise<ServiceLearningRequirementDto[]> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<RequirementRow[]>(
        'SELECT id::text, school_id::text, grade_level, required_hours, deadline_type, ' +
          'specific_deadline::text, is_active ' +
          'FROM sis_service_learning_requirements WHERE school_id = $1::uuid ORDER BY grade_level',
        tenant.schoolId,
      ),
    );
    return rows.map((r) => this.reqRowToDto(r));
  }

  async createRequirement(
    dto: CreateServiceLearningRequirementDto,
    actor: ResolvedActor,
  ): Promise<ServiceLearningRequirementDto> {
    await this.assertAdmin(actor);
    if (!SERVICE_LEARNING_DEADLINE_TYPES.includes(dto.deadlineType)) {
      throw new BadRequestException(
        'deadlineType must be one of ' + SERVICE_LEARNING_DEADLINE_TYPES.join(', '),
      );
    }
    if (dto.deadlineType === 'SPECIFIC_DATE' && !dto.specificDeadline) {
      throw new BadRequestException('SPECIFIC_DATE deadlineType requires specificDeadline');
    }
    if (dto.deadlineType !== 'SPECIFIC_DATE' && dto.specificDeadline) {
      throw new BadRequestException('specificDeadline only applies to deadlineType SPECIFIC_DATE');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$executeRawUnsafe(
        'INSERT INTO sis_service_learning_requirements ' +
          '(id, school_id, grade_level, required_hours, deadline_type, specific_deadline) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::date)',
        id,
        tenant.schoolId,
        dto.gradeLevel,
        dto.requiredHours,
        dto.deadlineType,
        dto.specificDeadline ?? null,
      ),
    );
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<RequirementRow[]>(
        'SELECT id::text, school_id::text, grade_level, required_hours, deadline_type, ' +
          'specific_deadline::text, is_active FROM sis_service_learning_requirements WHERE id = $1::uuid',
        id,
      ),
    );
    return this.reqRowToDto(rows[0]!);
  }

  // ─── Hours ───

  async submitHours(
    dto: SubmitServiceLearningHoursDto,
    actor: ResolvedActor,
  ): Promise<ServiceLearningHoursDto> {
    await this.assertCanSubmitForStudent(dto.studentId, actor);
    // Validate student exists in this tenant.
    const tenant = getCurrentTenant();
    const studentRows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        dto.studentId,
        tenant.schoolId,
      ),
    );
    if (studentRows.length === 0) {
      throw new BadRequestException('studentId does not match a student in this school');
    }
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$executeRawUnsafe(
        'INSERT INTO sis_service_learning_hours ' +
          '(id, student_id, organisation_name, activity_description, hours, service_date, ' +
          'supervisor_name, supervisor_contact, evidence_s3_key) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::date, $7, $8, $9)',
        id,
        dto.studentId,
        dto.organisationName,
        dto.activityDescription,
        dto.hours,
        dto.serviceDate,
        dto.supervisorName ?? null,
        dto.supervisorContact ?? null,
        dto.evidenceS3Key ?? null,
      ),
    );
    return this.getById(id, actor);
  }

  async listForStudent(
    studentId: string,
    actor: ResolvedActor,
  ): Promise<ServiceLearningHoursDto[]> {
    await this.assertCanReadStudent(studentId, actor);
    const tenant = getCurrentTenant();
    // REVIEW-P2C13 BLOCKING 4 — list joins through sis_students.school_id
    // so even if the row-scope helper short-circuits, the SQL still
    // refuses foreign-school student UUIDs.
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<HoursRow[]>(
        'SELECT h.id::text, h.student_id::text, h.organisation_name, h.activity_description, h.hours::text, ' +
          'h.service_date::text, h.supervisor_name, h.supervisor_contact, h.evidence_s3_key, h.status, ' +
          'h.reviewed_by::text, h.reviewed_at::text, h.review_notes, h.created_at::text ' +
          'FROM sis_service_learning_hours h ' +
          'JOIN sis_students s ON s.id = h.student_id ' +
          'WHERE h.student_id = $1::uuid AND s.school_id = $2::uuid ORDER BY h.service_date DESC',
        studentId,
        tenant.schoolId,
      ),
    );
    return rows.map((r) => this.hoursRowToDto(r));
  }

  async listPendingForReview(actor: ResolvedActor): Promise<ServiceLearningHoursDto[]> {
    await this.assertReviewer(actor);
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<HoursRow[]>(
        'SELECT h.id::text, h.student_id::text, h.organisation_name, h.activity_description, h.hours::text, ' +
          'h.service_date::text, h.supervisor_name, h.supervisor_contact, h.evidence_s3_key, h.status, ' +
          'h.reviewed_by::text, h.reviewed_at::text, h.review_notes, h.created_at::text ' +
          'FROM sis_service_learning_hours h ' +
          'JOIN sis_students s ON s.id = h.student_id ' +
          "WHERE s.school_id = $1::uuid AND h.status = 'PENDING' " +
          'ORDER BY h.created_at ASC',
        tenant.schoolId,
      ),
    );
    return rows.map((r) => this.hoursRowToDto(r));
  }

  async getById(id: string, actor: ResolvedActor): Promise<ServiceLearningHoursDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<HoursRow[]>(
        'SELECT h.id::text, h.student_id::text, h.organisation_name, h.activity_description, h.hours::text, ' +
          'h.service_date::text, h.supervisor_name, h.supervisor_contact, h.evidence_s3_key, h.status, ' +
          'h.reviewed_by::text, h.reviewed_at::text, h.review_notes, h.created_at::text ' +
          'FROM sis_service_learning_hours h ' +
          'JOIN sis_students s ON s.id = h.student_id ' +
          'WHERE h.id = $1::uuid AND s.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      ),
    );
    if (rows.length === 0) throw new NotFoundException('Service learning hours row not found');
    const row = rows[0]!;
    // Row-scope read after the basic fetch.
    await this.assertCanReadStudent(row.student_id, actor);
    return this.hoursRowToDto(row);
  }

  async reviewHours(
    id: string,
    dto: ReviewServiceLearningHoursDto,
    actor: ResolvedActor,
  ): Promise<ServiceLearningHoursDto> {
    await this.assertReviewer(actor);
    if (dto.decision !== 'APPROVED' && dto.decision !== 'REJECTED') {
      throw new BadRequestException('decision must be APPROVED or REJECTED');
    }
    const tenant = getCurrentTenant();
    // REVIEW-P2C13 BLOCKING 4 — lock + UPDATE + reload all carry the
    // school predicate through a sis_students JOIN so a School A
    // reviewer cannot review/approve School B hours by guessing the
    // hours UUID.
    const rows = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const locked = await tx.$queryRawUnsafe<Array<{ id: string; status: string }>>(
        'SELECT h.id::text AS id, h.status FROM sis_service_learning_hours h ' +
          'JOIN sis_students s ON s.id = h.student_id ' +
          'WHERE h.id = $1::uuid AND s.school_id = $2::uuid FOR UPDATE OF h',
        id,
        tenant.schoolId,
      );
      if (locked.length === 0) throw new NotFoundException('Service learning hours row not found');
      if (locked[0]!.status !== 'PENDING') {
        throw new BadRequestException(
          'Hours row is in status ' + locked[0]!.status + '; only PENDING rows can be reviewed.',
        );
      }
      await tx.$executeRawUnsafe(
        'UPDATE sis_service_learning_hours SET status = $1, reviewed_by = $2::uuid, ' +
          'reviewed_at = now(), review_notes = $3, updated_at = now() WHERE id = $4::uuid',
        dto.decision,
        actor.personId,
        dto.reviewNotes ?? null,
        id,
      );
      return tx.$queryRawUnsafe<HoursRow[]>(
        'SELECT h.id::text, h.student_id::text, h.organisation_name, h.activity_description, h.hours::text, ' +
          'h.service_date::text, h.supervisor_name, h.supervisor_contact, h.evidence_s3_key, h.status, ' +
          'h.reviewed_by::text, h.reviewed_at::text, h.review_notes, h.created_at::text ' +
          'FROM sis_service_learning_hours h ' +
          'JOIN sis_students s ON s.id = h.student_id ' +
          'WHERE h.id = $1::uuid AND s.school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    });
    return this.hoursRowToDto(rows[0]!);
  }

  async progressForStudent(
    studentId: string,
    actor: ResolvedActor,
  ): Promise<ServiceLearningProgressDto | null> {
    await this.assertCanReadStudent(studentId, actor);
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<
        Array<{
          grade_level: string | null;
          approved: string | null;
          pending: string | null;
          required: number | null;
        }>
      >(
        'SELECT s.grade_level, ' +
          "COALESCE(SUM(h.hours) FILTER (WHERE h.status = 'APPROVED'), 0)::text AS approved, " +
          "COALESCE(SUM(h.hours) FILTER (WHERE h.status = 'PENDING'), 0)::text AS pending, " +
          'r.required_hours AS required ' +
          'FROM sis_students s ' +
          'LEFT JOIN sis_service_learning_hours h ON h.student_id = s.id ' +
          'LEFT JOIN sis_service_learning_requirements r ON r.school_id = s.school_id AND r.grade_level = s.grade_level AND r.is_active = true ' +
          'WHERE s.id = $1::uuid AND s.school_id = $2::uuid ' +
          'GROUP BY s.grade_level, r.required_hours LIMIT 1',
        studentId,
        tenant.schoolId,
      ),
    );
    if (rows.length === 0) return null;
    const r = rows[0]!;
    const approved = r.approved === null ? 0 : Number(r.approved);
    const pending = r.pending === null ? 0 : Number(r.pending);
    const required = r.required ?? 0;
    return {
      studentId,
      gradeLevel: r.grade_level ?? '',
      approvedHours: approved,
      pendingHours: pending,
      requiredHours: required,
      remainingHours: Math.max(required - approved, 0),
    };
  }
}
