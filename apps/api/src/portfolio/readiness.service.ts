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
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  isUniqueViolation,
  resolveStudentIdForActor,
  isLinkedGuardianOf,
} from './portfolio-access';
import type {
  AssignPathwayDto,
  CreateMilestoneDto,
  CreatePathwayDto,
  MilestoneStatus,
  MilestoneStatusDto,
  PathwayAssignmentDto,
  PathwayMilestoneDto,
  ReadinessDashboardRowDto,
  ReadinessPathwayDetailDto,
  ReadinessPathwayDto,
  UpdateMilestoneDto,
  UpdateMilestoneStatusDto,
  UpdatePathwayDto,
} from './dto/portfolio-advanced.dto';

interface PathwayRow {
  id: string;
  school_id: string;
  name: string;
  description: string | null;
  pathway_type: ReadinessPathwayDto['pathwayType'];
  is_active: boolean;
  milestone_count: number;
  created_at: string;
  updated_at: string;
}

interface MilestoneRow {
  id: string;
  pathway_id: string;
  milestone_name: string;
  description: string | null;
  category: PathwayMilestoneDto['category'];
  sort_order: number;
  is_required: boolean;
  auto_check_source: string | null;
}

interface AssignmentRow {
  id: string;
  student_id: string;
  student_name: string | null;
  pathway_id: string;
  pathway_name: string | null;
  pathway_type: ReadinessPathwayDto['pathwayType'] | null;
  assigned_by: string;
  assigned_by_name: string | null;
  assigned_at: string;
  milestone_statuses: Array<{
    milestone_id?: string;
    milestoneId?: string;
    status: MilestoneStatus;
    completed_at?: string | null;
    completedAt?: string | null;
    notes?: string | null;
    progress_detail?: string | null;
    progressDetail?: string | null;
  }>;
  overall_progress: number | null;
  status: PathwayAssignmentDto['status'];
  notes: string | null;
  updated_at: string;
}

interface MilestoneStatusEntry {
  milestone_id: string;
  status: MilestoneStatus;
  completed_at: string | null;
  notes: string | null;
  progress_detail: string | null;
}

const SELECT_PATHWAY_BASE = `
  SELECT
    p.id::text AS id,
    p.school_id::text AS school_id,
    p.name,
    p.description,
    p.pathway_type,
    p.is_active,
    (SELECT COUNT(*)::int FROM pfl_pathway_milestones m WHERE m.pathway_id = p.id) AS milestone_count,
    p.created_at::text AS created_at,
    p.updated_at::text AS updated_at
  FROM pfl_readiness_pathways p
`;

const SELECT_MILESTONE_BASE = `
  SELECT
    m.id::text AS id,
    m.pathway_id::text AS pathway_id,
    m.milestone_name,
    m.description,
    m.category,
    m.sort_order,
    m.is_required,
    m.auto_check_source
  FROM pfl_pathway_milestones m
`;

const SELECT_ASSIGNMENT_BASE = `
  SELECT
    a.id::text AS id,
    a.student_id::text AS student_id,
    (SELECT ip.first_name || ' ' || ip.last_name
       FROM sis_students s
       JOIN platform.platform_students ps ON ps.id = s.platform_student_id
       JOIN platform.iam_person ip ON ip.id = ps.person_id
       WHERE s.id = a.student_id LIMIT 1) AS student_name,
    a.pathway_id::text AS pathway_id,
    (SELECT name FROM pfl_readiness_pathways WHERE id = a.pathway_id) AS pathway_name,
    (SELECT pathway_type FROM pfl_readiness_pathways WHERE id = a.pathway_id) AS pathway_type,
    a.assigned_by::text AS assigned_by,
    (SELECT ip.first_name || ' ' || ip.last_name
       FROM hr_employees e JOIN platform.iam_person ip ON ip.id = e.person_id
       WHERE e.id = a.assigned_by LIMIT 1) AS assigned_by_name,
    a.assigned_at::text AS assigned_at,
    a.milestone_statuses,
    a.overall_progress,
    a.status,
    a.notes,
    a.updated_at::text AS updated_at
  FROM pfl_student_pathway_assignments a
`;

@Injectable()
export class ReadinessPathwayService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly permissions: PermissionCheckService,
  ) {}

  private pathwayRowToDto(r: PathwayRow): ReadinessPathwayDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      name: r.name,
      description: r.description,
      pathwayType: r.pathway_type,
      isActive: r.is_active,
      milestoneCount: Number(r.milestone_count),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private milestoneRowToDto(r: MilestoneRow): PathwayMilestoneDto {
    return {
      id: r.id,
      pathwayId: r.pathway_id,
      milestoneName: r.milestone_name,
      description: r.description,
      category: r.category,
      sortOrder: r.sort_order,
      isRequired: r.is_required,
      autoCheckSource: r.auto_check_source,
    };
  }

  private normaliseStatuses(raw: AssignmentRow['milestone_statuses']): MilestoneStatusEntry[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((s) => ({
      milestone_id: (s.milestone_id ?? s.milestoneId)!,
      status: s.status,
      completed_at: s.completed_at ?? s.completedAt ?? null,
      notes: s.notes ?? null,
      progress_detail: s.progress_detail ?? s.progressDetail ?? null,
    }));
  }

  private async assignmentRowToDto(r: AssignmentRow): Promise<PathwayAssignmentDto> {
    const statuses = this.normaliseStatuses(r.milestone_statuses);
    // Compose milestoneStatuses by joining with the pathway's milestone
    // definitions so the response carries milestone_name/category/sort_order/
    // is_required/auto_check_source alongside status.
    const milestones = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_MILESTONE_BASE + ' WHERE m.pathway_id = $1::uuid ORDER BY m.sort_order ASC',
        r.pathway_id,
      );
    })) as MilestoneRow[];
    const milestoneMap = new Map(milestones.map((m) => [m.id, m]));
    const milestoneStatuses: MilestoneStatusDto[] = milestones.map((m) => {
      const s = statuses.find((x) => x.milestone_id === m.id);
      return {
        milestoneId: m.id,
        milestoneName: m.milestone_name,
        category: m.category,
        sortOrder: m.sort_order,
        isRequired: m.is_required,
        status: (s?.status as MilestoneStatus) ?? 'NOT_STARTED',
        completedAt: s?.completed_at ?? null,
        notes: s?.notes ?? null,
        progressDetail: s?.progress_detail ?? null,
        autoCheckSource: m.auto_check_source,
      };
    });
    // Pick up any orphan status entries that no longer match a milestone
    // (defensive against milestone removal) — they are rendered first.
    for (const s of statuses) {
      if (!milestoneMap.has(s.milestone_id)) {
        milestoneStatuses.push({
          milestoneId: s.milestone_id,
          milestoneName: '(removed milestone)',
          category: 'OTHER',
          sortOrder: -1,
          isRequired: false,
          status: s.status,
          completedAt: s.completed_at,
          notes: s.notes,
          progressDetail: s.progress_detail,
          autoCheckSource: null,
        });
      }
    }
    return {
      id: r.id,
      studentId: r.student_id,
      studentName: r.student_name,
      pathwayId: r.pathway_id,
      pathwayName: r.pathway_name,
      pathwayType: r.pathway_type,
      assignedById: r.assigned_by,
      assignedByName: r.assigned_by_name,
      assignedAt: r.assigned_at,
      milestoneStatuses,
      overallProgress: Number(r.overall_progress ?? 0),
      status: r.status,
      notes: r.notes,
      updatedAt: r.updated_at,
    };
  }

  // Counsellor / admin scope — required for pathway CRUD + assignment.
  private async assertCounsellorScope(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const has = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'ach-003:write',
      'ach-003:admin',
    ]);
    if (!has) {
      throw new ForbiddenException(
        'Pathway management requires counsellor or admin scope (ach-003:write).',
      );
    }
    if (actor.personType === 'STUDENT' || actor.personType === 'GUARDIAN') {
      throw new ForbiddenException(
        'Students and guardians cannot assign pathways or edit milestone definitions.',
      );
    }
  }

  // Compute overall_progress from a status array given the milestone set
  // (only required milestones contribute to the percentage).
  private computeProgress(
    statuses: MilestoneStatusEntry[],
    requiredMilestoneIds: Set<string>,
  ): number {
    if (requiredMilestoneIds.size === 0) return 0;
    let completed = 0;
    for (const s of statuses) {
      if (s.status === 'COMPLETED' && requiredMilestoneIds.has(s.milestone_id)) {
        completed += 1;
      }
    }
    return Math.round((completed / requiredMilestoneIds.size) * 100 * 100) / 100;
  }

  // ── Pathway CRUD ──────────────────────────────────────────

  async listPathways(includeInactive = false): Promise<ReadinessPathwayDto[]> {
    const tenant = getCurrentTenant();
    const sql = includeInactive
      ? SELECT_PATHWAY_BASE + ' WHERE p.school_id = $1::uuid ORDER BY p.name ASC'
      : SELECT_PATHWAY_BASE +
        ' WHERE p.school_id = $1::uuid AND p.is_active = true ORDER BY p.name ASC';
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(sql, tenant.schoolId);
    })) as PathwayRow[];
    return rows.map((r) => this.pathwayRowToDto(r));
  }

  async getPathway(pathwayId: string): Promise<ReadinessPathwayDetailDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_PATHWAY_BASE + ' WHERE p.id = $1::uuid AND p.school_id = $2::uuid LIMIT 1',
        pathwayId,
        tenant.schoolId,
      );
    })) as PathwayRow[];
    if (rows.length === 0) throw new NotFoundException('Readiness pathway not found');
    const milestones = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_MILESTONE_BASE + ' WHERE m.pathway_id = $1::uuid ORDER BY m.sort_order ASC',
        pathwayId,
      );
    })) as MilestoneRow[];
    return {
      ...this.pathwayRowToDto(rows[0]!),
      milestones: milestones.map((m) => this.milestoneRowToDto(m)),
    };
  }

  async createPathway(actor: ResolvedActor, input: CreatePathwayDto): Promise<ReadinessPathwayDto> {
    await this.assertCounsellorScope(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO pfl_readiness_pathways (id, school_id, name, description, pathway_type, is_active) VALUES ($1::uuid, $2::uuid, $3, $4, $5, true)',
          id,
          tenant.schoolId,
          input.name,
          input.description ?? null,
          input.pathwayType,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(`A pathway named "${input.name}" already exists.`);
      }
      throw err;
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_PATHWAY_BASE + ' WHERE p.id = $1::uuid', id);
    })) as PathwayRow[];
    return this.pathwayRowToDto(rows[0]!);
  }

  async patchPathway(
    pathwayId: string,
    actor: ResolvedActor,
    input: UpdatePathwayDto,
  ): Promise<ReadinessPathwayDto> {
    await this.assertCounsellorScope(actor);
    const tenant = getCurrentTenant();
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (input.name !== undefined) push('name', input.name);
    if (input.description !== undefined) push('description', input.description);
    if (input.isActive !== undefined) push('is_active', input.isActive);
    if (sets.length === 0) return this.getPathway(pathwayId);
    sets.push('updated_at = now()');
    params.push(pathwayId);
    params.push(tenant.schoolId);
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          `UPDATE pfl_readiness_pathways SET ${sets.join(', ')} WHERE id = $${params.length - 1}::uuid AND school_id = $${params.length}::uuid`,
          ...params,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(`A pathway named "${input.name}" already exists.`);
      }
      throw err;
    }
    return this.getPathway(pathwayId);
  }

  // ── Milestone CRUD ────────────────────────────────────────

  async createMilestone(
    pathwayId: string,
    actor: ResolvedActor,
    input: CreateMilestoneDto,
  ): Promise<PathwayMilestoneDto> {
    await this.assertCounsellorScope(actor);
    await this.getPathway(pathwayId); // validates existence + school scope
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO pfl_pathway_milestones (id, pathway_id, milestone_name, description, category, sort_order, is_required, auto_check_source) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8)',
          id,
          pathwayId,
          input.milestoneName,
          input.description ?? null,
          input.category,
          input.sortOrder,
          input.isRequired ?? true,
          input.autoCheckSource ?? null,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          `A milestone named "${input.milestoneName}" already exists in this pathway.`,
        );
      }
      throw err;
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_MILESTONE_BASE + ' WHERE m.id = $1::uuid', id);
    })) as MilestoneRow[];
    return this.milestoneRowToDto(rows[0]!);
  }

  async patchMilestone(
    milestoneId: string,
    actor: ResolvedActor,
    input: UpdateMilestoneDto,
  ): Promise<PathwayMilestoneDto> {
    await this.assertCounsellorScope(actor);
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (input.milestoneName !== undefined) push('milestone_name', input.milestoneName);
    if (input.description !== undefined) push('description', input.description);
    if (input.category !== undefined) push('category', input.category);
    if (input.sortOrder !== undefined) push('sort_order', input.sortOrder);
    if (input.isRequired !== undefined) push('is_required', input.isRequired);
    if (input.autoCheckSource !== undefined) push('auto_check_source', input.autoCheckSource);
    if (sets.length === 0) {
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          SELECT_MILESTONE_BASE + ' WHERE m.id = $1::uuid',
          milestoneId,
        );
      })) as MilestoneRow[];
      if (rows.length === 0) throw new NotFoundException('Milestone not found');
      return this.milestoneRowToDto(rows[0]!);
    }
    sets.push('updated_at = now()');
    params.push(milestoneId);
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          `UPDATE pfl_pathway_milestones SET ${sets.join(', ')} WHERE id = $${params.length}::uuid`,
          ...params,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('Milestone name collision with another row in this pathway.');
      }
      throw err;
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_MILESTONE_BASE + ' WHERE m.id = $1::uuid', milestoneId);
    })) as MilestoneRow[];
    if (rows.length === 0) throw new NotFoundException('Milestone not found');
    return this.milestoneRowToDto(rows[0]!);
  }

  async removeMilestone(milestoneId: string, actor: ResolvedActor): Promise<void> {
    await this.assertCounsellorScope(actor);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'DELETE FROM pfl_pathway_milestones WHERE id = $1::uuid',
        milestoneId,
      );
    });
  }

  // ── Assignment ───────────────────────────────────────────

  async assignToStudent(
    pathwayId: string,
    actor: ResolvedActor,
    input: AssignPathwayDto,
  ): Promise<PathwayAssignmentDto> {
    await this.assertCounsellorScope(actor);
    if (!actor.employeeId) {
      throw new BadRequestException(
        'Pathway assignment requires the counsellor have an hr_employees row.',
      );
    }
    const pathway = await this.getPathway(pathwayId);
    // Initialise milestone_statuses with NOT_STARTED entries for every milestone.
    const initialStatuses: MilestoneStatusEntry[] = pathway.milestones.map((m) => ({
      milestone_id: m.id,
      status: 'NOT_STARTED',
      completed_at: null,
      notes: null,
      progress_detail: null,
    }));
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO pfl_student_pathway_assignments (id, student_id, pathway_id, assigned_by, milestone_statuses, overall_progress, status, notes) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::jsonb, 0, $6, $7)',
          id,
          input.studentId,
          pathwayId,
          actor.employeeId,
          JSON.stringify(initialStatuses),
          'ACTIVE',
          input.notes ?? null,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'Student is already assigned to this pathway. Use PATCH to update milestones.',
        );
      }
      throw err;
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_ASSIGNMENT_BASE + ' WHERE a.id = $1::uuid', id);
    })) as AssignmentRow[];
    return this.assignmentRowToDto(rows[0]!);
  }

  async getStudentReadiness(
    studentId: string,
    actor: ResolvedActor,
  ): Promise<PathwayAssignmentDto[]> {
    // Row scope: admin / counsellor (ach-003:write) sees any student.
    // Students see own. Guardians see linked children.
    const tenant = getCurrentTenant();
    if (!actor.isSchoolAdmin) {
      const ownerStudentId = await resolveStudentIdForActor(this.tenantPrisma, actor);
      const isOwner = ownerStudentId === studentId;
      const isGuardian = await isLinkedGuardianOf(this.tenantPrisma, actor, studentId);
      const hasCounsellorScope = await this.permissions.hasAnyPermissionInTenant(
        actor.accountId,
        tenant.schoolId,
        ['ach-003:write', 'ach-003:admin'],
      );
      if (!isOwner && !isGuardian && !hasCounsellorScope) {
        throw new NotFoundException('Student not found');
      }
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_ASSIGNMENT_BASE +
          " WHERE a.student_id = $1::uuid AND a.status = 'ACTIVE' ORDER BY a.assigned_at DESC",
        studentId,
      );
    })) as AssignmentRow[];
    return Promise.all(rows.map((r) => this.assignmentRowToDto(r)));
  }

  async getAssignment(assignmentId: string, actor: ResolvedActor): Promise<PathwayAssignmentDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_ASSIGNMENT_BASE +
          ` WHERE a.id = $1::uuid
             AND EXISTS (
               SELECT 1 FROM pfl_readiness_pathways p
               WHERE p.id = a.pathway_id AND p.school_id = $2::uuid
             )
           LIMIT 1`,
        assignmentId,
        tenant.schoolId,
      );
    })) as AssignmentRow[];
    if (rows.length === 0) throw new NotFoundException('Assignment not found');
    // Row scope same as getStudentReadiness — admin / counsellor / owner / guardian.
    if (!actor.isSchoolAdmin) {
      const ownerStudentId = await resolveStudentIdForActor(this.tenantPrisma, actor);
      const isOwner = ownerStudentId === rows[0]!.student_id;
      const isGuardian = await isLinkedGuardianOf(this.tenantPrisma, actor, rows[0]!.student_id);
      const hasCounsellorScope = await this.permissions.hasAnyPermissionInTenant(
        actor.accountId,
        tenant.schoolId,
        ['ach-003:write', 'ach-003:admin'],
      );
      if (!isOwner && !isGuardian && !hasCounsellorScope) {
        throw new NotFoundException('Assignment not found');
      }
    }
    return this.assignmentRowToDto(rows[0]!);
  }

  async updateMilestoneStatus(
    assignmentId: string,
    actor: ResolvedActor,
    input: UpdateMilestoneStatusDto,
  ): Promise<PathwayAssignmentDto> {
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const tenant = getCurrentTenant();
      const rows = (await client.$queryRawUnsafe(
        `SELECT a.*, p.school_id::text AS p_school_id
         FROM pfl_student_pathway_assignments a
         JOIN pfl_readiness_pathways p ON p.id = a.pathway_id
         WHERE a.id = $1::uuid AND p.school_id = $2::uuid
         FOR UPDATE OF a`,
        assignmentId,
        tenant.schoolId,
      )) as Array<{
        id: string;
        student_id: string;
        pathway_id: string;
        milestone_statuses: AssignmentRow['milestone_statuses'];
        overall_progress: number | null;
        status: PathwayAssignmentDto['status'];
      }>;
      if (rows.length === 0) throw new NotFoundException('Assignment not found');
      const studentId = rows[0]!.student_id;

      // Authorisation: admin / counsellor scope OR the owning student.
      const ownerStudentId = await resolveStudentIdForActor(this.tenantPrisma, actor);
      const isOwner = ownerStudentId === studentId;
      const hasCounsellorScope = await this.permissions.hasAnyPermissionInTenant(
        actor.accountId,
        tenant.schoolId,
        ['ach-003:write', 'ach-003:admin'],
      );
      if (!actor.isSchoolAdmin && !isOwner && !hasCounsellorScope) {
        throw new ForbiddenException(
          'Only the owning student, a counsellor, or an admin can update milestone status.',
        );
      }
      if (rows[0]!.status !== 'ACTIVE' && !actor.isSchoolAdmin) {
        throw new BadRequestException(
          'Cannot update milestones on a non-ACTIVE pathway assignment.',
        );
      }

      // Validate milestone belongs to the pathway.
      const milestoneRows = (await client.$queryRawUnsafe(
        'SELECT id::text AS id, is_required FROM pfl_pathway_milestones WHERE id = $1::uuid AND pathway_id = $2::uuid LIMIT 1',
        input.milestoneId,
        rows[0]!.pathway_id,
      )) as Array<{ id: string; is_required: boolean }>;
      if (milestoneRows.length === 0) {
        throw new BadRequestException('milestoneId does not belong to this pathway.');
      }

      // Update milestone_statuses inline. Recompute overall_progress.
      const existing = this.normaliseStatuses(rows[0]!.milestone_statuses);
      const idx = existing.findIndex((s) => s.milestone_id === input.milestoneId);
      const wasCompleted = idx >= 0 && existing[idx]!.status === 'COMPLETED';
      const isTransitioningToCompleted = input.status === 'COMPLETED' && !wasCompleted;

      const next: MilestoneStatusEntry = {
        milestone_id: input.milestoneId,
        status: input.status,
        completed_at: input.status === 'COMPLETED' ? new Date().toISOString() : null,
        notes: input.notes ?? (idx >= 0 ? existing[idx]!.notes : null),
        progress_detail: input.progressDetail ?? (idx >= 0 ? existing[idx]!.progress_detail : null),
      };
      if (idx >= 0) existing[idx] = next;
      else existing.push(next);

      // Pull required milestone ids for progress computation
      const allMilestones = (await client.$queryRawUnsafe(
        'SELECT id::text AS id, is_required FROM pfl_pathway_milestones WHERE pathway_id = $1::uuid',
        rows[0]!.pathway_id,
      )) as Array<{ id: string; is_required: boolean }>;
      const requiredIds = new Set(allMilestones.filter((m) => m.is_required).map((m) => m.id));
      const newProgress = this.computeProgress(existing, requiredIds);

      await client.$executeRawUnsafe(
        'UPDATE pfl_student_pathway_assignments SET milestone_statuses = $1::jsonb, overall_progress = $2, updated_at = now() WHERE id = $3::uuid',
        JSON.stringify(existing),
        newProgress,
        assignmentId,
      );

      // Emit pfl.pathway.milestone_completed when transitioning to COMPLETED.
      if (isTransitioningToCompleted) {
        // Resolve milestone name for the payload.
        const milestoneNameRows = (await client.$queryRawUnsafe(
          'SELECT milestone_name FROM pfl_pathway_milestones WHERE id = $1::uuid LIMIT 1',
          input.milestoneId,
        )) as Array<{ milestone_name: string }>;
        await this.kafka.emit({
          topic: 'pfl.pathway.milestone_completed',
          key: assignmentId,
          sourceModule: 'portfolio',
          payload: {
            assignmentId,
            pathwayId: rows[0]!.pathway_id,
            studentId,
            schoolId: tenant.schoolId,
            milestoneId: input.milestoneId,
            milestoneName: milestoneNameRows[0]?.milestone_name ?? null,
            completedAt: next.completed_at,
            overallProgress: newProgress,
          },
        });
      }

      const after = (await client.$queryRawUnsafe(
        SELECT_ASSIGNMENT_BASE + ' WHERE a.id = $1::uuid',
        assignmentId,
      )) as AssignmentRow[];
      return this.assignmentRowToDto(after[0]!);
    });
  }

  /**
   * Internal — used by the MilestoneAutoCheckWorker. Walks every active
   * assignment whose pathway carries the given auto_check_source and
   * marks the matching milestone COMPLETED for the supplied student.
   * Returns the count of assignments touched.
   */
  async autoCheckByCrossModuleEvent(
    schoolId: string,
    studentId: string,
    autoCheckSource: string,
  ): Promise<number> {
    let updatedAssignments = 0;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT a.id::text AS id, a.pathway_id::text AS pathway_id,
                a.milestone_statuses, a.status::text AS status,
                m.id::text AS milestone_id, m.milestone_name
         FROM pfl_student_pathway_assignments a
         JOIN pfl_readiness_pathways p ON p.id = a.pathway_id
         JOIN pfl_pathway_milestones m ON m.pathway_id = a.pathway_id
         WHERE p.school_id = $1::uuid
           AND a.student_id = $2::uuid
           AND a.status = 'ACTIVE'
           AND m.auto_check_source = $3
         FOR UPDATE OF a`,
        schoolId,
        studentId,
        autoCheckSource,
      )) as Array<{
        id: string;
        pathway_id: string;
        milestone_statuses: AssignmentRow['milestone_statuses'];
        status: string;
        milestone_id: string;
        milestone_name: string;
      }>;
      for (const row of rows) {
        const existing = this.normaliseStatuses(row.milestone_statuses);
        const idx = existing.findIndex((s) => s.milestone_id === row.milestone_id);
        const wasCompleted = idx >= 0 && existing[idx]!.status === 'COMPLETED';
        if (wasCompleted) continue;
        const next: MilestoneStatusEntry = {
          milestone_id: row.milestone_id,
          status: 'COMPLETED',
          completed_at: new Date().toISOString(),
          notes: idx >= 0 ? existing[idx]!.notes : 'Auto-checked from cross-module event.',
          progress_detail: idx >= 0 ? existing[idx]!.progress_detail : `source=${autoCheckSource}`,
        };
        if (idx >= 0) existing[idx] = next;
        else existing.push(next);

        const reqRows = (await tx.$queryRawUnsafe(
          'SELECT id::text AS id, is_required FROM pfl_pathway_milestones WHERE pathway_id = $1::uuid',
          row.pathway_id,
        )) as Array<{ id: string; is_required: boolean }>;
        const requiredIds = new Set(reqRows.filter((m) => m.is_required).map((m) => m.id));
        const newProgress = this.computeProgress(existing, requiredIds);
        await tx.$executeRawUnsafe(
          'UPDATE pfl_student_pathway_assignments SET milestone_statuses = $1::jsonb, overall_progress = $2, updated_at = now() WHERE id = $3::uuid',
          JSON.stringify(existing),
          newProgress,
          row.id,
        );
        await this.kafka.emit({
          topic: 'pfl.pathway.milestone_completed',
          key: row.id,
          sourceModule: 'portfolio',
          payload: {
            assignmentId: row.id,
            pathwayId: row.pathway_id,
            studentId,
            schoolId,
            milestoneId: row.milestone_id,
            milestoneName: row.milestone_name,
            completedAt: next.completed_at,
            overallProgress: newProgress,
            autoCheckSource,
          },
        });
        updatedAssignments += 1;
      }
    });
    return updatedAssignments;
  }

  // ── Dashboard ────────────────────────────────────────────

  async getDashboard(
    actor: ResolvedActor,
    atRiskOnly = false,
  ): Promise<ReadinessDashboardRowDto[]> {
    await this.assertCounsellorScope(actor);
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT
           a.student_id::text AS student_id,
           (SELECT ip.first_name || ' ' || ip.last_name
              FROM sis_students s
              JOIN platform.platform_students ps ON ps.id = s.platform_student_id
              JOIN platform.iam_person ip ON ip.id = ps.person_id
              WHERE s.id = a.student_id LIMIT 1) AS student_name,
           (SELECT grade_level FROM sis_students WHERE id = a.student_id LIMIT 1) AS grade_level,
           p.id::text AS pathway_id,
           p.name AS pathway_name,
           p.pathway_type AS pathway_type,
           a.overall_progress,
           a.status,
           a.milestone_statuses,
           (SELECT COUNT(*)::int FROM pfl_pathway_milestones m WHERE m.pathway_id = p.id AND m.is_required = true) AS total_required
         FROM pfl_student_pathway_assignments a
         JOIN pfl_readiness_pathways p ON p.id = a.pathway_id
         WHERE p.school_id = $1::uuid AND a.status = 'ACTIVE'
         ORDER BY a.overall_progress ASC, student_name ASC`,
        tenant.schoolId,
      );
    })) as Array<{
      student_id: string;
      student_name: string | null;
      grade_level: string | null;
      pathway_id: string;
      pathway_name: string;
      pathway_type: ReadinessPathwayDto['pathwayType'];
      overall_progress: number | null;
      status: PathwayAssignmentDto['status'];
      milestone_statuses: AssignmentRow['milestone_statuses'];
      total_required: number;
    }>;
    const dashboard: ReadinessDashboardRowDto[] = rows.map((r) => {
      const statuses = this.normaliseStatuses(r.milestone_statuses);
      const completed = statuses.filter((s) => s.status === 'COMPLETED').length;
      const progress = Number(r.overall_progress ?? 0);
      const isAtRisk = progress < 50;
      return {
        studentId: r.student_id,
        studentName: r.student_name,
        gradeLevel: r.grade_level,
        pathwayId: r.pathway_id,
        pathwayName: r.pathway_name,
        pathwayType: r.pathway_type,
        overallProgress: progress,
        status: r.status,
        completedMilestones: completed,
        totalMilestones: Number(r.total_required),
        isAtRisk,
      };
    });
    return atRiskOnly ? dashboard.filter((r) => r.isAtRisk) : dashboard;
  }
}
