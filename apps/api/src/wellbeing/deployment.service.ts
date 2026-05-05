import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { SurveyTemplateService } from './survey-template.service';
import {
  ActivateDeploymentResponseDto,
  CreateDeploymentDto,
  DeploymentResponseDto,
  DeploymentStatus,
  DeploymentTargetType,
  ListDeploymentsQueryDto,
} from './dto/wellbeing.dto';

interface DeploymentRow {
  id: string;
  school_id: string;
  template_id: string;
  template_name: string | null;
  deployed_by: string;
  deployer_first: string | null;
  deployer_last: string | null;
  deploy_at: string;
  expires_at: string | null;
  target_type: string;
  target_ids: string[] | null;
  status: string;
  total_targeted: number | null;
  total_completed: number | null;
  created_at: string;
  updated_at: string;
}

const SELECT_DEPLOYMENT_BASE =
  'SELECT d.id::text AS id, d.school_id::text AS school_id, ' +
  'd.template_id::text AS template_id, t.name AS template_name, ' +
  'd.deployed_by::text AS deployed_by, ' +
  'dp.first_name AS deployer_first, dp.last_name AS deployer_last, ' +
  'TO_CHAR(d.deploy_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS deploy_at, ' +
  'TO_CHAR(d.expires_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS expires_at, ' +
  'd.target_type, d.target_ids::text[] AS target_ids, d.status, ' +
  'd.total_targeted, d.total_completed, ' +
  'TO_CHAR(d.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(d.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM svc_wellbeing_deployments d ' +
  'LEFT JOIN svc_wellbeing_survey_templates t ON t.id = d.template_id ' +
  'LEFT JOIN hr_employees de ON de.id = d.deployed_by ' +
  'LEFT JOIN platform.iam_person dp ON dp.id = de.person_id ';

function fullName(first: string | null, last: string | null): string | null {
  if (first && last) return first + ' ' + last;
  return null;
}

function rowToDto(r: DeploymentRow): DeploymentResponseDto {
  const targeted = r.total_targeted;
  const completed = r.total_completed;
  let completionRate: number | null = null;
  if (targeted !== null && targeted > 0 && completed !== null) {
    completionRate = Math.round((completed / targeted) * 1000) / 10; // 1 decimal place
  }
  return {
    id: r.id,
    schoolId: r.school_id,
    templateId: r.template_id,
    templateName: r.template_name,
    deployedById: r.deployed_by,
    deployedByName: fullName(r.deployer_first, r.deployer_last),
    deployAt: r.deploy_at,
    expiresAt: r.expires_at,
    targetType: r.target_type as DeploymentTargetType,
    targetIds: r.target_ids,
    status: r.status as DeploymentStatus,
    totalTargeted: targeted,
    totalCompleted: completed,
    completionRate,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class DeploymentService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
    private readonly templates: SurveyTemplateService,
  ) {}

  /**
   * Counsellor scope: admin OR holds cou-004:write — same canonical
   * counsellor signal SurveyTemplateService uses.
   */
  private async hasCounsellorScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'cou-004:write',
    ]);
  }

  /**
   * Visibility model:
   *   - Admin                            → all deployments in tenant.
   *   - Counsellor (STAFF, employeeId)   → own deployments
   *                                        (deployed_by = me).
   *   - Anyone else                      → no rows.
   *
   * The Step 6 dashboard for counsellors lists their own deployments;
   * the school-wide rollup is admin-only.
   */
  private buildVisibility(
    actor: ResolvedActor,
    start: number,
  ): { fragment: string; params: unknown[]; consumed: number } {
    if (actor.isSchoolAdmin) return { fragment: '', params: [], consumed: 0 };
    if (actor.personType === 'STAFF' && actor.employeeId) {
      return {
        fragment: 'AND d.deployed_by = $' + start + '::uuid ',
        params: [actor.employeeId],
        consumed: 1,
      };
    }
    return { fragment: 'AND FALSE ', params: [], consumed: 0 };
  }

  async list(
    query: ListDeploymentsQueryDto,
    actor: ResolvedActor,
  ): Promise<DeploymentResponseDto[]> {
    const tenant = getCurrentTenant();
    const limit = Math.min(query.limit ?? 100, 200);
    const visibility = this.buildVisibility(actor, 2);
    const sql: string[] = [SELECT_DEPLOYMENT_BASE, 'WHERE d.school_id = $1::uuid '];
    const params: unknown[] = [tenant.schoolId, ...visibility.params];
    let idx = 2 + visibility.consumed;
    if (visibility.fragment) sql.push(visibility.fragment);
    if (query.status) {
      sql.push('AND d.status = $' + idx + ' ');
      params.push(query.status);
      idx++;
    }
    if (query.templateId) {
      sql.push('AND d.template_id = $' + idx + '::uuid ');
      params.push(query.templateId);
      idx++;
    }
    sql.push('ORDER BY d.deploy_at DESC, d.created_at DESC LIMIT ' + limit);
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<DeploymentRow[]>(sql.join(''), ...params);
    });
    return rows.map(rowToDto);
  }

  async getById(id: string, actor: ResolvedActor): Promise<DeploymentResponseDto> {
    return this.loadOrFail(id, actor);
  }

  /**
   * Create a SCHEDULED deployment. Validates the template exists in
   * this tenant and is active. Validates target_type/target_ids shape:
   *   - CASELOAD / SCHOOL  →  target_ids must be null (the activate
   *                           endpoint resolves the audience at runtime).
   *   - CLASS / YEAR_GROUP / CUSTOM_LIST
   *                        →  target_ids must be a non-empty UUID array.
   * Status defaults to SCHEDULED. Stamps deployed_by from actor.employeeId.
   */
  async create(input: CreateDeploymentDto, actor: ResolvedActor): Promise<DeploymentResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors or admins can create wellbeing deployments');
    }
    if (!actor.employeeId) {
      throw new ForbiddenException('Deployer must have an employee record');
    }
    const tenant = getCurrentTenant();

    // Validate template (loadActiveOrFail throws on missing / inactive / no questions).
    await this.templates.loadActiveOrFail(input.templateId);

    // Validate target shape.
    const requiresIds =
      input.targetType === 'CLASS' ||
      input.targetType === 'YEAR_GROUP' ||
      input.targetType === 'CUSTOM_LIST';
    if (requiresIds) {
      if (!input.targetIds || input.targetIds.length === 0) {
        throw new BadRequestException(
          input.targetType + ' deployments require a non-empty targetIds array',
        );
      }
    } else {
      if (input.targetIds && input.targetIds.length > 0) {
        throw new BadRequestException(
          input.targetType +
            ' deployments must NOT carry targetIds — the audience is resolved on activation',
        );
      }
    }

    // Validate window (the schema window_chk also catches this, but the
    // service surfaces a friendly message).
    if (input.expiresAt && new Date(input.expiresAt) <= new Date(input.deployAt)) {
      throw new BadRequestException('expiresAt must be after deployAt');
    }

    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO svc_wellbeing_deployments (id, school_id, template_id, deployed_by, deploy_at, expires_at, target_type, target_ids, status) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz, $6::timestamptz, $7, $8::uuid[], 'SCHEDULED')",
        id,
        tenant.schoolId,
        input.templateId,
        actor.employeeId,
        input.deployAt,
        input.expiresAt ?? null,
        input.targetType,
        input.targetIds ?? null,
      );
    });
    return this.loadOrFail(id, actor);
  }

  /**
   * Keystone — SCHEDULED → ACTIVE. Resolves the target audience into a
   * student id list, bulk-INSERTs svc_wellbeing_checkins rows (one per
   * targeted student, completed_at NULL = PENDING), and stamps
   * total_targeted on the deployment. The Step 5 student UI then
   * renders these PENDING rows as the to-do list.
   *
   * Audience resolution per target_type:
   *   - CASELOAD     → students on the deployer's ACTIVE caseload rows.
   *   - CLASS        → students with ACTIVE enrollment in any of the
   *                    supplied class ids.
   *   - YEAR_GROUP   → not implemented this cycle (target_ids carries
   *                    grade-level UUIDs but the SIS schema currently
   *                    keys grade as a string on sis_students). Returns
   *                    400 with a "deferred" message for now.
   *   - SCHOOL       → every active student in the school.
   *   - CUSTOM_LIST  → exactly the supplied student ids (validated to
   *                    exist in this tenant).
   *
   * The locked-row UPDATE pattern matches every other Cycle 11 state-
   * machine transition. Bulk-INSERT runs inside the same tx so a
   * partial failure rolls back cleanly. Stamps assigned_counselor_id
   * from the deployer's employeeId where applicable (CASELOAD always;
   * other audiences leave assignment to a future explicit assignment
   * pass).
   */
  async activate(id: string, actor: ResolvedActor): Promise<ActivateDeploymentResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors or admins can activate wellbeing deployments');
    }
    if (!actor.employeeId) {
      throw new ForbiddenException('Activator must have an employee record');
    }
    const tenant = getCurrentTenant();

    let checkinsCreated = 0;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Lock the deployment row.
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT id, school_id::text AS school_id, template_id::text AS template_id, ' +
          'deployed_by::text AS deployed_by, target_type, target_ids::text[] AS target_ids, status ' +
          'FROM svc_wellbeing_deployments WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        id,
        tenant.schoolId,
      )) as Array<{
        id: string;
        school_id: string;
        template_id: string;
        deployed_by: string;
        target_type: string;
        target_ids: string[] | null;
        status: string;
      }>;
      if (lockRows.length === 0) throw new NotFoundException('Deployment ' + id);
      const dep = lockRows[0]!;
      if (dep.status !== 'SCHEDULED') {
        throw new BadRequestException(
          'Deployment is in status ' + dep.status + '; only SCHEDULED can be activated',
        );
      }

      // Resolve the audience.
      const studentIds = await this.resolveAudience(
        tx,
        tenant.schoolId,
        dep.target_type as DeploymentTargetType,
        dep.target_ids,
        dep.deployed_by,
      );

      if (studentIds.length === 0) {
        throw new BadRequestException(
          'Audience resolution returned 0 students for ' + dep.target_type + ' targeting',
        );
      }

      // Bulk-INSERT check-ins (one per student, PENDING).
      for (const sid of studentIds) {
        await tx.$executeRawUnsafe(
          'INSERT INTO svc_wellbeing_checkins (id, school_id, student_id, template_id, deployment_id, assigned_counselor_id) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid)',
          generateId(),
          tenant.schoolId,
          sid,
          dep.template_id,
          id,
          actor.employeeId,
        );
      }

      checkinsCreated = studentIds.length;

      // Flip status + stamp total_targeted.
      await tx.$executeRawUnsafe(
        "UPDATE svc_wellbeing_deployments SET status = 'ACTIVE', total_targeted = $2, total_completed = COALESCE(total_completed, 0), updated_at = now() " +
          'WHERE id = $1::uuid',
        id,
        checkinsCreated,
      );
    });

    const deployment = await this.loadOrFail(id, actor);
    return { deployment, checkinsCreated };
  }

  async complete(id: string, actor: ResolvedActor): Promise<DeploymentResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors or admins can complete wellbeing deployments');
    }
    await this.transitionStatus(id, ['ACTIVE'], 'COMPLETED');
    return this.loadOrFail(id, actor);
  }

  async cancel(id: string, actor: ResolvedActor): Promise<DeploymentResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors or admins can cancel wellbeing deployments');
    }
    await this.transitionStatus(id, ['SCHEDULED', 'ACTIVE'], 'CANCELLED');
    return this.loadOrFail(id, actor);
  }

  // ─── Internal helpers ─────────────────────────────────────────

  private async loadOrFail(id: string, actor: ResolvedActor): Promise<DeploymentResponseDto> {
    const tenant = getCurrentTenant();
    const visibility = this.buildVisibility(actor, 3);
    const sql =
      SELECT_DEPLOYMENT_BASE +
      'WHERE d.id = $1::uuid AND d.school_id = $2::uuid ' +
      visibility.fragment;
    const params: unknown[] = [id, tenant.schoolId, ...visibility.params];
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<DeploymentRow[]>(sql, ...params);
    });
    if (rows.length === 0) throw new NotFoundException('Deployment ' + id);
    return rowToDto(rows[0]!);
  }

  private async transitionStatus(
    id: string,
    allowedFrom: DeploymentStatus[],
    target: DeploymentStatus,
  ): Promise<void> {
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT status FROM svc_wellbeing_deployments WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        id,
        tenant.schoolId,
      )) as Array<{ status: string }>;
      if (lockRows.length === 0) throw new NotFoundException('Deployment ' + id);
      if (!allowedFrom.includes(lockRows[0]!.status as DeploymentStatus)) {
        throw new BadRequestException(
          'Deployment is in status ' +
            lockRows[0]!.status +
            '; only [' +
            allowedFrom.join(', ') +
            '] can transition to ' +
            target,
        );
      }
      await tx.$executeRawUnsafe(
        'UPDATE svc_wellbeing_deployments SET status = $2, updated_at = now() WHERE id = $1::uuid',
        id,
        target,
      );
    });
  }

  /**
   * Resolves a target_type + target_ids into a flat distinct list of
   * sis_students.id values for the bulk check-in insert. Runs inside
   * the open tx so the audience snapshot is consistent with the
   * deployment row lock.
   */
  private async resolveAudience(
    tx: { $queryRawUnsafe: <T>(sql: string, ...params: unknown[]) => Promise<T> },
    _schoolId: string,
    targetType: DeploymentTargetType,
    targetIds: string[] | null,
    deployedBy: string,
  ): Promise<string[]> {
    if (targetType === 'CASELOAD') {
      const rows = await tx.$queryRawUnsafe<Array<{ student_id: string }>>(
        'SELECT DISTINCT c.student_id::text AS student_id ' +
          'FROM svc_caseloads c ' +
          "WHERE c.counselor_id = $1::uuid AND c.status = 'ACTIVE'",
        deployedBy,
      );
      return rows.map((r) => r.student_id);
    }

    if (targetType === 'SCHOOL') {
      const rows = await tx.$queryRawUnsafe<Array<{ student_id: string }>>(
        "SELECT DISTINCT s.id::text AS student_id FROM sis_students s WHERE s.status = 'ACTIVE'",
      );
      return rows.map((r) => r.student_id);
    }

    if (targetType === 'CLASS') {
      if (!targetIds || targetIds.length === 0) return [];
      const rows = await tx.$queryRawUnsafe<Array<{ student_id: string }>>(
        'SELECT DISTINCT e.student_id::text AS student_id ' +
          'FROM sis_enrollments e ' +
          "WHERE e.class_id = ANY($1::uuid[]) AND e.status = 'ACTIVE'",
        targetIds,
      );
      return rows.map((r) => r.student_id);
    }

    if (targetType === 'CUSTOM_LIST') {
      if (!targetIds || targetIds.length === 0) return [];
      // Validate every supplied id exists in this tenant.
      const rows = await tx.$queryRawUnsafe<Array<{ student_id: string }>>(
        'SELECT DISTINCT s.id::text AS student_id FROM sis_students s WHERE s.id = ANY($1::uuid[])',
        targetIds,
      );
      return rows.map((r) => r.student_id);
    }

    if (targetType === 'YEAR_GROUP') {
      throw new BadRequestException(
        'YEAR_GROUP targeting is deferred to a future cycle. Use CUSTOM_LIST with the resolved student ids for now.',
      );
    }

    throw new BadRequestException('Unsupported target_type ' + targetType);
  }
}
