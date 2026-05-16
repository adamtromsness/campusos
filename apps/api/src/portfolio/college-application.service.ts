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
import { resolveStudentIdForActor, isLinkedGuardianOf } from './portfolio-access';
import type {
  CollegeApplicationDto,
  CollegeApplicationStatus,
  CollegeApplicationType,
  CreateCollegeApplicationDto,
  UpdateCollegeApplicationDto,
} from './dto/portfolio-advanced.dto';

interface AppRow {
  id: string;
  student_id: string;
  student_name: string | null;
  college_name: string;
  application_type: CollegeApplicationType;
  deadline: string | null;
  status: CollegeApplicationStatus;
  essay_s3_key: string | null;
  recommendation_count: number;
  transcript_sent: boolean;
  financial_aid_applied: boolean;
  notes: string | null;
  decision_date: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_APP_BASE = `
  SELECT
    a.id::text AS id,
    a.student_id::text AS student_id,
    (SELECT ip.first_name || ' ' || ip.last_name
       FROM sis_students s
       JOIN platform.platform_students ps ON ps.id = s.platform_student_id
       JOIN platform.iam_person ip ON ip.id = ps.person_id
       WHERE s.id = a.student_id LIMIT 1) AS student_name,
    a.college_name,
    a.application_type,
    a.deadline::text AS deadline,
    a.status,
    a.essay_s3_key,
    a.recommendation_count,
    a.transcript_sent,
    a.financial_aid_applied,
    a.notes,
    a.decision_date::text AS decision_date,
    a.created_at::text AS created_at,
    a.updated_at::text AS updated_at
  FROM pfl_college_applications a
`;

const TERMINAL_STATUSES: CollegeApplicationStatus[] = ['ACCEPTED', 'REJECTED', 'WAITLISTED'];

@Injectable()
export class CollegeApplicationService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  private rowToDto(r: AppRow): CollegeApplicationDto {
    return {
      id: r.id,
      studentId: r.student_id,
      studentName: r.student_name,
      collegeName: r.college_name,
      applicationType: r.application_type,
      deadline: r.deadline,
      status: r.status,
      essayS3Key: r.essay_s3_key,
      recommendationCount: Number(r.recommendation_count),
      transcriptSent: r.transcript_sent,
      financialAidApplied: r.financial_aid_applied,
      notes: r.notes,
      decisionDate: r.decision_date,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private async hasCounsellorScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'ach-003:write',
      'ach-003:admin',
    ]);
  }

  private async assertCanWriteForStudent(actor: ResolvedActor, studentId: string): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const ownerStudentId = await resolveStudentIdForActor(this.tenantPrisma, actor);
    if (ownerStudentId === studentId) return;
    // Counsellor on-behalf creates allowed via staff scope.
    if (actor.personType === 'STAFF') {
      const has = await this.hasCounsellorScope(actor);
      if (has) return;
    }
    throw new ForbiddenException(
      'Only the owning student or a counsellor / admin can manage this college application.',
    );
  }

  async listForStudent(studentId: string, actor: ResolvedActor): Promise<CollegeApplicationDto[]> {
    // Row scope: admin / counsellor / owner / linked guardian.
    if (!actor.isSchoolAdmin) {
      const ownerStudentId = await resolveStudentIdForActor(this.tenantPrisma, actor);
      const isOwner = ownerStudentId === studentId;
      const isGuardian = await isLinkedGuardianOf(this.tenantPrisma, actor, studentId);
      const isCounsellor = await this.hasCounsellorScope(actor);
      if (!isOwner && !isGuardian && !isCounsellor) {
        throw new NotFoundException('Student not found');
      }
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_APP_BASE +
          ' WHERE a.student_id = $1::uuid ORDER BY a.deadline ASC NULLS LAST, a.created_at DESC',
        studentId,
      );
    })) as AppRow[];
    return rows.map((r) => this.rowToDto(r));
  }

  async getById(applicationId: string, actor: ResolvedActor): Promise<CollegeApplicationDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_APP_BASE + ' WHERE a.id = $1::uuid LIMIT 1',
        applicationId,
      );
    })) as AppRow[];
    if (rows.length === 0) throw new NotFoundException('Application not found');
    // Row scope check
    if (!actor.isSchoolAdmin) {
      const ownerStudentId = await resolveStudentIdForActor(this.tenantPrisma, actor);
      const isOwner = ownerStudentId === rows[0]!.student_id;
      const isGuardian = await isLinkedGuardianOf(this.tenantPrisma, actor, rows[0]!.student_id);
      const isCounsellor = await this.hasCounsellorScope(actor);
      if (!isOwner && !isGuardian && !isCounsellor) {
        throw new NotFoundException('Application not found');
      }
    }
    return this.rowToDto(rows[0]!);
  }

  async create(
    actor: ResolvedActor,
    input: CreateCollegeApplicationDto,
  ): Promise<CollegeApplicationDto> {
    let studentId = input.studentId ?? null;
    if (!studentId) {
      // Default to the calling student. Counsellors must provide studentId.
      const ownerStudentId = await resolveStudentIdForActor(this.tenantPrisma, actor);
      if (!ownerStudentId) {
        throw new BadRequestException(
          'studentId is required for non-student callers (counsellors / admins).',
        );
      }
      studentId = ownerStudentId;
    }
    await this.assertCanWriteForStudent(actor, studentId);
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO pfl_college_applications (id, student_id, college_name, application_type, deadline, status, notes) VALUES ($1::uuid, $2::uuid, $3, $4, $5::date, $6, $7)',
        id,
        studentId,
        input.collegeName,
        input.applicationType,
        input.deadline ?? null,
        input.status ?? 'RESEARCHING',
        input.notes ?? null,
      );
    });
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_APP_BASE + ' WHERE a.id = $1::uuid', id);
    })) as AppRow[];
    return this.rowToDto(rows[0]!);
  }

  async patch(
    applicationId: string,
    actor: ResolvedActor,
    input: UpdateCollegeApplicationDto,
  ): Promise<CollegeApplicationDto> {
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT id::text AS id, student_id::text AS student_id, status FROM pfl_college_applications WHERE id = $1::uuid FOR UPDATE',
        applicationId,
      )) as Array<{ id: string; student_id: string; status: CollegeApplicationStatus }>;
      if (rows.length === 0) throw new NotFoundException('Application not found');
      await this.assertCanWriteForStudent(actor, rows[0]!.student_id);

      const sets: string[] = [];
      const params: unknown[] = [];
      const push = (col: string, value: unknown) => {
        params.push(value);
        sets.push(`${col} = $${params.length}`);
      };
      if (input.collegeName !== undefined) push('college_name', input.collegeName);
      if (input.applicationType !== undefined) push('application_type', input.applicationType);
      if (input.deadline !== undefined) {
        if (input.deadline === null) {
          sets.push('deadline = NULL');
        } else {
          params.push(input.deadline);
          sets.push(`deadline = $${params.length}::date`);
        }
      }
      if (input.status !== undefined) {
        push('status', input.status);
        // Auto-stamp decision_date on first transition to a terminal status if
        // the caller did not supply one.
        if (
          TERMINAL_STATUSES.includes(input.status) &&
          input.decisionDate === undefined &&
          !TERMINAL_STATUSES.includes(rows[0]!.status)
        ) {
          sets.push('decision_date = CURRENT_DATE');
        }
      }
      if (input.essayS3Key !== undefined) push('essay_s3_key', input.essayS3Key);
      if (input.recommendationCount !== undefined)
        push('recommendation_count', input.recommendationCount);
      if (input.transcriptSent !== undefined) push('transcript_sent', input.transcriptSent);
      if (input.financialAidApplied !== undefined)
        push('financial_aid_applied', input.financialAidApplied);
      if (input.notes !== undefined) push('notes', input.notes);
      if (input.decisionDate !== undefined) {
        if (input.decisionDate === null) {
          sets.push('decision_date = NULL');
        } else {
          params.push(input.decisionDate);
          sets.push(`decision_date = $${params.length}::date`);
        }
      }
      if (sets.length === 0) {
        const cur = (await client.$queryRawUnsafe(
          SELECT_APP_BASE + ' WHERE a.id = $1::uuid',
          applicationId,
        )) as AppRow[];
        return this.rowToDto(cur[0]!);
      }
      sets.push('updated_at = now()');
      params.push(applicationId);
      await client.$executeRawUnsafe(
        `UPDATE pfl_college_applications SET ${sets.join(', ')} WHERE id = $${params.length}::uuid`,
        ...params,
      );
      const after = (await client.$queryRawUnsafe(
        SELECT_APP_BASE + ' WHERE a.id = $1::uuid',
        applicationId,
      )) as AppRow[];
      return this.rowToDto(after[0]!);
    });
  }

  async remove(applicationId: string, actor: ResolvedActor): Promise<void> {
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT student_id::text AS student_id FROM pfl_college_applications WHERE id = $1::uuid FOR UPDATE',
        applicationId,
      )) as Array<{ student_id: string }>;
      if (rows.length === 0) throw new NotFoundException('Application not found');
      await this.assertCanWriteForStudent(actor, rows[0]!.student_id);
      await client.$executeRawUnsafe(
        'DELETE FROM pfl_college_applications WHERE id = $1::uuid',
        applicationId,
      );
    });
  }

  /**
   * Counsellor school-wide deadlines view — upcoming open applications
   * sorted by deadline. Admin and counsellor scope only.
   */
  async listUpcomingDeadlines(actor: ResolvedActor): Promise<CollegeApplicationDto[]> {
    const isCounsellor = await this.hasCounsellorScope(actor);
    if (!isCounsellor) {
      throw new ForbiddenException(
        'School-wide deadline view requires counsellor or admin scope (ach-003:write).',
      );
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_APP_BASE +
          " WHERE a.status NOT IN ('ACCEPTED', 'REJECTED', 'WAITLISTED') AND a.deadline IS NOT NULL ORDER BY a.deadline ASC LIMIT 200",
      );
    })) as AppRow[];
    return rows.map((r) => this.rowToDto(r));
  }
}
