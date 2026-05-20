import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import {
  AppraisalCycleDto,
  AppraisalDto,
  AppraisalFrameworkDto,
  AppraisalGoalDto,
  AppraisalCommentDto,
  AppraisalRating,
  AppraisalStatus,
  CreateAppraisalCommentDto,
  CreateAppraisalCycleDto,
  CreateAppraisalDto,
  CreateAppraisalFrameworkDto,
  CreateAppraisalGoalDto,
  CreateLessonObservationDto,
  CycleStatus,
  CycleType,
  GoalProgress,
  LessonObservationDto,
  UpdateAppraisalCycleDto,
  UpdateAppraisalDto,
  UpdateAppraisalFrameworkDto,
  UpdateAppraisalGoalDto,
  UpdateLessonObservationDto,
} from './dto/appraisals.dto';

interface FrameworkRow {
  id: string;
  school_id: string;
  name: string;
  description: string | null;
  criteria: unknown;
  is_active: boolean;
  created_at: string;
}

interface CycleRow {
  id: string;
  school_id: string;
  academic_year_id: string;
  framework_id: string;
  framework_name: string | null;
  cycle_type: string;
  name: string;
  starts_on: string;
  ends_on: string;
  status: string;
  closed_at: string | null;
  created_at: string;
}

interface AppraisalRow {
  id: string;
  cycle_id: string;
  cycle_name: string | null;
  cycle_type: string | null;
  employee_id: string;
  employee_first: string | null;
  employee_last: string | null;
  appraiser_id: string | null;
  appraiser_first: string | null;
  appraiser_last: string | null;
  school_id: string;
  overall_rating: string | null;
  self_review: string | null;
  appraiser_review: string | null;
  development_plan: string | null;
  status: string;
  signed_off_at: string | null;
  signed_off_by: string | null;
  signed_off_by_first: string | null;
  signed_off_by_last: string | null;
  linked_approval_id: string | null;
  created_at: string;
}

interface GoalRow {
  id: string;
  appraisal_id: string;
  goal_text: string;
  success_criteria: string | null;
  target_date: string | null;
  progress: string;
  progress_notes: string | null;
  sort_order: number;
  created_at: string;
}

interface CommentRow {
  id: string;
  appraisal_id: string;
  author_id: string;
  author_first: string | null;
  author_last: string | null;
  comment_text: string;
  is_visible_to_employee: boolean;
  created_at: string;
}

interface ObservationRow {
  id: string;
  appraisal_id: string | null;
  school_id: string;
  observer_id: string;
  observer_first: string | null;
  observer_last: string | null;
  observed_employee_id: string;
  observed_first: string | null;
  observed_last: string | null;
  observation_date: string;
  observed_class_label: string;
  observed_class_id: string | null;
  duration_minutes: number | null;
  overall_grade: string | null;
  strengths: string | null;
  areas_for_development: string | null;
  notes: string | null;
  is_locked: boolean;
  locked_at: string | null;
  locked_by: string | null;
  created_at: string;
}

const SELECT_FRAMEWORK =
  'SELECT id::text AS id, school_id::text AS school_id, name, description, criteria, ' +
  '       is_active, created_at::text AS created_at ' +
  'FROM hr_appraisal_frameworks ';

const SELECT_CYCLE_BASE =
  'SELECT c.id::text AS id, c.school_id::text AS school_id, ' +
  '       c.academic_year_id::text AS academic_year_id, ' +
  '       c.framework_id::text AS framework_id, f.name AS framework_name, ' +
  '       c.cycle_type, c.name, c.starts_on::text AS starts_on, c.ends_on::text AS ends_on, ' +
  '       c.status, c.closed_at::text AS closed_at, c.created_at::text AS created_at ' +
  'FROM hr_appraisal_cycles c ' +
  'LEFT JOIN hr_appraisal_frameworks f ON f.id = c.framework_id ';

const SELECT_APPRAISAL_BASE =
  'SELECT a.id::text AS id, a.cycle_id::text AS cycle_id, c.name AS cycle_name, ' +
  '       c.cycle_type AS cycle_type, ' +
  '       a.employee_id::text AS employee_id, ipe.first_name AS employee_first, ' +
  '       ipe.last_name AS employee_last, ' +
  '       a.appraiser_id::text AS appraiser_id, ipa.first_name AS appraiser_first, ' +
  '       ipa.last_name AS appraiser_last, a.school_id::text AS school_id, ' +
  '       a.overall_rating, a.self_review, a.appraiser_review, a.development_plan, ' +
  '       a.status, a.signed_off_at::text AS signed_off_at, ' +
  '       a.signed_off_by::text AS signed_off_by, ' +
  '       ipso.first_name AS signed_off_by_first, ipso.last_name AS signed_off_by_last, ' +
  '       a.linked_approval_id::text AS linked_approval_id, a.created_at::text AS created_at ' +
  'FROM hr_appraisals a ' +
  'LEFT JOIN hr_appraisal_cycles c ON c.id = a.cycle_id ' +
  'LEFT JOIN hr_employees emp ON emp.id = a.employee_id ' +
  'LEFT JOIN platform.iam_person ipe ON ipe.id = emp.person_id ' +
  'LEFT JOIN hr_employees app ON app.id = a.appraiser_id ' +
  'LEFT JOIN platform.iam_person ipa ON ipa.id = app.person_id ' +
  'LEFT JOIN hr_employees so ON so.id = a.signed_off_by ' +
  'LEFT JOIN platform.iam_person ipso ON ipso.id = so.person_id ';

const SELECT_GOAL =
  'SELECT id::text AS id, appraisal_id::text AS appraisal_id, goal_text, success_criteria, ' +
  '       target_date::text AS target_date, progress, progress_notes, sort_order, ' +
  '       created_at::text AS created_at ' +
  'FROM hr_appraisal_goals ';

const SELECT_COMMENT_BASE =
  'SELECT c.id::text AS id, c.appraisal_id::text AS appraisal_id, ' +
  '       c.author_id::text AS author_id, ip.first_name AS author_first, ' +
  '       ip.last_name AS author_last, c.comment_text, c.is_visible_to_employee, ' +
  '       c.created_at::text AS created_at ' +
  'FROM hr_appraisal_comments c ' +
  'LEFT JOIN hr_employees emp ON emp.id = c.author_id ' +
  'LEFT JOIN platform.iam_person ip ON ip.id = emp.person_id ';

const SELECT_OBSERVATION_BASE =
  'SELECT o.id::text AS id, o.appraisal_id::text AS appraisal_id, ' +
  '       o.school_id::text AS school_id, o.observer_id::text AS observer_id, ' +
  '       ipo.first_name AS observer_first, ipo.last_name AS observer_last, ' +
  '       o.observed_employee_id::text AS observed_employee_id, ' +
  '       ipoe.first_name AS observed_first, ipoe.last_name AS observed_last, ' +
  '       o.observation_date::text AS observation_date, o.observed_class_label, ' +
  '       o.observed_class_id::text AS observed_class_id, o.duration_minutes, ' +
  '       o.overall_grade, o.strengths, o.areas_for_development, o.notes, ' +
  '       o.is_locked, o.locked_at::text AS locked_at, o.locked_by::text AS locked_by, ' +
  '       o.created_at::text AS created_at ' +
  'FROM hr_lesson_observations o ' +
  'LEFT JOIN hr_employees obs ON obs.id = o.observer_id ' +
  'LEFT JOIN platform.iam_person ipo ON ipo.id = obs.person_id ' +
  'LEFT JOIN hr_employees obse ON obse.id = o.observed_employee_id ' +
  'LEFT JOIN platform.iam_person ipoe ON ipoe.id = obse.person_id ';

@Injectable()
export class AppraisalFrameworkService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  async list(includeInactive: boolean): Promise<AppraisalFrameworkDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const where = includeInactive
        ? 'WHERE school_id = $1::uuid'
        : 'WHERE school_id = $1::uuid AND is_active = true';
      const rows = (await client.$queryRawUnsafe(
        SELECT_FRAMEWORK + where + ' ORDER BY name',
        tenant.schoolId,
      )) as FrameworkRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async create(
    input: CreateAppraisalFrameworkDto,
    actor: ResolvedActor,
  ): Promise<AppraisalFrameworkDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO hr_appraisal_frameworks (id, school_id, name, description, criteria) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb)',
          id,
          tenant.schoolId,
          input.name,
          input.description ?? null,
          JSON.stringify(input.criteria ?? []),
        );
      } catch (e: unknown) {
        if (this.isUniqueViolation(e)) {
          throw new BadRequestException(
            `An appraisal framework with name "${input.name}" already exists.`,
          );
        }
        throw e;
      }
      const rows = (await tx.$queryRawUnsafe(
        SELECT_FRAMEWORK + 'WHERE id = $1::uuid LIMIT 1',
        id,
      )) as FrameworkRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  async patch(
    id: string,
    input: UpdateAppraisalFrameworkDto,
    actor: ResolvedActor,
  ): Promise<AppraisalFrameworkDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id FROM hr_appraisal_frameworks WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        id,
      )) as Array<{ id: string }>;
      if (lock.length === 0) throw new NotFoundException('Framework not found');
      const sets: string[] = [];
      const values: unknown[] = [];
      let n = 1;
      const push = (col: string, value: unknown, cast?: string) => {
        sets.push(`${col} = $${n}${cast ? `::${cast}` : ''}`);
        values.push(value);
        n += 1;
      };
      if (input.name !== undefined) push('name', input.name);
      if (input.description !== undefined) push('description', input.description);
      if (input.criteria !== undefined) push('criteria', JSON.stringify(input.criteria), 'jsonb');
      if (input.isActive !== undefined) push('is_active', input.isActive);
      if (sets.length === 0) {
        const rows = (await tx.$queryRawUnsafe(
          SELECT_FRAMEWORK + 'WHERE id = $1::uuid LIMIT 1',
          id,
        )) as FrameworkRow[];
        return this.rowToDto(rows[0]!);
      }
      sets.push('updated_at = now()');
      values.push(tenant.schoolId, id);
      try {
        await tx.$executeRawUnsafe(
          `UPDATE hr_appraisal_frameworks SET ${sets.join(', ')} ` +
            `WHERE school_id = $${n}::uuid AND id = $${n + 1}::uuid`,
          ...values,
        );
      } catch (e: unknown) {
        if (this.isUniqueViolation(e)) {
          throw new BadRequestException('A framework with that name already exists.');
        }
        throw e;
      }
      const rows = (await tx.$queryRawUnsafe(
        SELECT_FRAMEWORK + 'WHERE id = $1::uuid LIMIT 1',
        id,
      )) as FrameworkRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  private async assertAdmin(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'hr-005:write',
      'hr-005:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException(
        'Appraisal framework administration requires hr-005:write or school admin.',
      );
    }
  }

  private rowToDto(r: FrameworkRow): AppraisalFrameworkDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      name: r.name,
      description: r.description,
      criteria: r.criteria,
      isActive: r.is_active,
      createdAt: r.created_at,
    };
  }

  private isUniqueViolation(err: unknown): boolean {
    const e = err as { code?: string; meta?: { code?: string }; message?: string };
    if (!e) return false;
    if (e.code === 'P2010' && e.meta?.code === '23505') return true;
    if (typeof e.message === 'string' && /unique/i.test(e.message)) return true;
    return false;
  }
}

@Injectable()
export class AppraisalCycleService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  async list(): Promise<AppraisalCycleDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_CYCLE_BASE + 'WHERE c.school_id = $1::uuid ORDER BY c.starts_on DESC',
        tenant.schoolId,
      )) as CycleRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async getById(id: string): Promise<AppraisalCycleDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_CYCLE_BASE + 'WHERE c.school_id = $1::uuid AND c.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as CycleRow[];
      if (rows.length === 0) throw new NotFoundException('Cycle not found');
      return this.rowToDto(rows[0]!);
    });
  }

  async create(input: CreateAppraisalCycleDto, actor: ResolvedActor): Promise<AppraisalCycleDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Validate framework + academic year live in the same school.
      const fw = (await tx.$queryRawUnsafe(
        'SELECT id FROM hr_appraisal_frameworks WHERE school_id = $1::uuid AND id = $2::uuid AND is_active = true LIMIT 1',
        tenant.schoolId,
        input.frameworkId,
      )) as Array<{ id: string }>;
      if (fw.length === 0) {
        throw new BadRequestException('frameworkId does not match an active framework.');
      }
      const ay = (await tx.$queryRawUnsafe(
        'SELECT id FROM sis_academic_years WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        input.academicYearId,
      )) as Array<{ id: string }>;
      if (ay.length === 0) {
        throw new BadRequestException(
          'academicYearId does not match an academic year in this school.',
        );
      }
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO hr_appraisal_cycles ' +
            '(id, school_id, academic_year_id, framework_id, cycle_type, name, starts_on, ends_on) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::date, $8::date)',
          id,
          tenant.schoolId,
          input.academicYearId,
          input.frameworkId,
          input.cycleType,
          input.name,
          input.startsOn,
          input.endsOn,
        );
      } catch (e: unknown) {
        if (this.isUniqueViolation(e)) {
          throw new BadRequestException(
            `A ${input.cycleType} cycle already exists for this academic year.`,
          );
        }
        throw e;
      }
    });
    // Re-read AFTER commit so the row is visible (Prisma $transaction
    // can't be nested through AsyncLocalStorage).
    return this.getById(id);
  }

  async patch(
    id: string,
    input: UpdateAppraisalCycleDto,
    actor: ResolvedActor,
  ): Promise<AppraisalCycleDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id, status FROM hr_appraisal_cycles ' +
          'WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        id,
      )) as Array<{ id: string; status: string }>;
      if (lock.length === 0) throw new NotFoundException('Cycle not found');
      const cur = lock[0]!.status as CycleStatus;
      const sets: string[] = [];
      const values: unknown[] = [];
      let n = 1;
      const push = (col: string, value: unknown, cast?: string) => {
        sets.push(`${col} = $${n}${cast ? `::${cast}` : ''}`);
        values.push(value);
        n += 1;
      };
      if (input.name !== undefined) push('name', input.name);
      if (input.startsOn !== undefined) push('starts_on', input.startsOn, 'date');
      if (input.endsOn !== undefined) push('ends_on', input.endsOn, 'date');
      if (input.status !== undefined && input.status !== cur) {
        if (cur === 'ARCHIVED') {
          throw new BadRequestException('Cannot transition out of ARCHIVED.');
        }
        if (cur === 'CLOSED' && input.status !== 'ARCHIVED' && input.status !== 'OPEN') {
          throw new BadRequestException('Closed cycles can only re-open or archive.');
        }
        push('status', input.status);
        if (input.status === 'CLOSED' || input.status === 'ARCHIVED') {
          sets.push('closed_at = COALESCE(closed_at, now())');
        } else if (input.status === 'OPEN') {
          sets.push('closed_at = NULL');
        }
      }
      if (sets.length === 0) return;
      sets.push('updated_at = now()');
      values.push(tenant.schoolId, id);
      await tx.$executeRawUnsafe(
        `UPDATE hr_appraisal_cycles SET ${sets.join(', ')} ` +
          `WHERE school_id = $${n}::uuid AND id = $${n + 1}::uuid`,
        ...values,
      );
    });
    // Re-read AFTER commit (Prisma $transaction can't be nested).
    return this.getById(id);
  }

  private async assertAdmin(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'hr-005:write',
      'hr-005:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException('Cycle administration requires hr-005:write or school admin.');
    }
  }

  private rowToDto(r: CycleRow): AppraisalCycleDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      academicYearId: r.academic_year_id,
      frameworkId: r.framework_id,
      frameworkName: r.framework_name,
      cycleType: r.cycle_type as CycleType,
      name: r.name,
      startsOn: r.starts_on,
      endsOn: r.ends_on,
      status: r.status as CycleStatus,
      closedAt: r.closed_at,
      createdAt: r.created_at,
    };
  }

  private isUniqueViolation(err: unknown): boolean {
    const e = err as { code?: string; meta?: { code?: string }; message?: string };
    if (!e) return false;
    if (e.code === 'P2010' && e.meta?.code === '23505') return true;
    if (typeof e.message === 'string' && /unique/i.test(e.message)) return true;
    return false;
  }
}

/**
 * AppraisalService — the keystone service of the P2-4c appraisal
 * surface. SIGNED_OFF is the immutable terminal status; the service
 * refuses ANY mutation once an appraisal hits that state, mirroring
 * the Cycle 11 svc_session_notes locked pattern + P2C3 telehealth
 * COMPLETED + multi-column signed_off_chk schema invariant.
 */
@Injectable()
export class AppraisalService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  async list(
    args: { cycleId?: string; employeeId?: string },
    actor: ResolvedActor,
  ): Promise<AppraisalDto[]> {
    const tenant = getCurrentTenant();
    const isAdmin = await this.isAdmin(actor);
    const params: unknown[] = [tenant.schoolId];
    let where = 'WHERE a.school_id = $1::uuid';
    if (args.cycleId) {
      params.push(args.cycleId);
      where += ` AND a.cycle_id = $${params.length}::uuid`;
    }
    if (args.employeeId) {
      params.push(args.employeeId);
      where += ` AND a.employee_id = $${params.length}::uuid`;
    }
    // Non-admin actors see only their own appraisal record.
    if (!isAdmin) {
      if (!actor.employeeId) {
        return [];
      }
      params.push(actor.employeeId);
      where += ` AND a.employee_id = $${params.length}::uuid`;
    }
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_APPRAISAL_BASE + where + ' ORDER BY a.created_at DESC',
        ...params,
      )) as AppraisalRow[];
      const dtos = await Promise.all(rows.map((r) => this.assembleDto(client, r, isAdmin, actor)));
      return dtos;
    });
  }

  async getById(id: string, actor: ResolvedActor): Promise<AppraisalDto> {
    const tenant = getCurrentTenant();
    const isAdmin = await this.isAdmin(actor);
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_APPRAISAL_BASE + 'WHERE a.school_id = $1::uuid AND a.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as AppraisalRow[];
      if (rows.length === 0) throw new NotFoundException('Appraisal not found');
      const row = rows[0]!;
      // Row scope — non-admin actors can only see their own appraisal.
      if (!isAdmin && row.employee_id !== actor.employeeId) {
        throw new NotFoundException('Appraisal not found');
      }
      return this.assembleDto(client, row, isAdmin, actor);
    });
  }

  async create(input: CreateAppraisalDto, actor: ResolvedActor): Promise<AppraisalDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Validate cycle + employee + appraiser belong to this school.
      const cyc = (await tx.$queryRawUnsafe(
        "SELECT id FROM hr_appraisal_cycles WHERE school_id = $1::uuid AND id = $2::uuid AND status = 'OPEN' LIMIT 1",
        tenant.schoolId,
        input.cycleId,
      )) as Array<{ id: string }>;
      if (cyc.length === 0) {
        throw new BadRequestException(
          'cycleId does not match an OPEN appraisal cycle in this school.',
        );
      }
      const emp = (await tx.$queryRawUnsafe(
        'SELECT id FROM hr_employees WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        input.employeeId,
      )) as Array<{ id: string }>;
      if (emp.length === 0) {
        throw new BadRequestException('employeeId does not match an employee in this school.');
      }
      if (input.appraiserId) {
        const a = (await tx.$queryRawUnsafe(
          'SELECT id FROM hr_employees WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
          tenant.schoolId,
          input.appraiserId,
        )) as Array<{ id: string }>;
        if (a.length === 0) {
          throw new BadRequestException('appraiserId does not match an employee in this school.');
        }
      }
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO hr_appraisals (id, cycle_id, employee_id, appraiser_id, school_id) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid)',
          id,
          input.cycleId,
          input.employeeId,
          input.appraiserId ?? null,
          tenant.schoolId,
        );
      } catch (e: unknown) {
        if (this.isUniqueViolation(e)) {
          throw new BadRequestException(
            'An appraisal already exists for this employee in this cycle.',
          );
        }
        throw e;
      }
    });
    // Re-read AFTER commit (see AppraisalCycleService.create fix).
    return this.getById(id, actor);
  }

  async patch(id: string, input: UpdateAppraisalDto, actor: ResolvedActor): Promise<AppraisalDto> {
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id, status, employee_id::text AS employee_id ' +
          'FROM hr_appraisals WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        id,
      )) as Array<{ id: string; status: string; employee_id: string }>;
      if (lock.length === 0) throw new NotFoundException('Appraisal not found');
      const cur = lock[0]!.status as AppraisalStatus;
      // SIGNED_OFF is the immutable terminal — service-side discipline.
      if (cur === 'SIGNED_OFF') {
        throw new BadRequestException(
          'Appraisal is SIGNED_OFF and cannot be modified. Open a new cycle for further review.',
        );
      }
      // Authorisation — admin/appraiser can edit appraiser_review +
      // overall_rating + status; the appraisee can edit self_review
      // only on their own appraisal in DRAFT/IN_REVIEW.
      const isAdmin = await this.isAdmin(actor);
      const isOwner = actor.employeeId !== null && actor.employeeId === lock[0]!.employee_id;
      if (!isAdmin) {
        // The owning employee can only update self_review.
        if (!isOwner) throw new ForbiddenException('You cannot edit this appraisal.');
        const allowedKeys = ['selfReview'] as const;
        for (const k of Object.keys(input) as Array<keyof UpdateAppraisalDto>) {
          if (!(allowedKeys as readonly string[]).includes(k as string) && input[k] !== undefined) {
            throw new ForbiddenException(`Employees can only edit selfReview, not ${String(k)}.`);
          }
        }
      }
      const sets: string[] = [];
      const values: unknown[] = [];
      let n = 1;
      const push = (col: string, value: unknown) => {
        sets.push(`${col} = $${n}`);
        values.push(value);
        n += 1;
      };
      if (input.appraiserId !== undefined) push('appraiser_id', input.appraiserId);
      if (input.overallRating !== undefined) push('overall_rating', input.overallRating);
      if (input.selfReview !== undefined) push('self_review', input.selfReview);
      if (input.appraiserReview !== undefined) push('appraiser_review', input.appraiserReview);
      if (input.developmentPlan !== undefined) push('development_plan', input.developmentPlan);
      if (input.status !== undefined && input.status !== cur) {
        push('status', input.status);
        if (input.status === 'SIGNED_OFF') {
          if (!actor.employeeId) {
            throw new BadRequestException(
              'Only an employee actor (with an hr_employees row) can sign off an appraisal.',
            );
          }
          sets.push('signed_off_at = now()');
          // Postgres won't auto-cast text → uuid; explicit cast required.
          sets.push('signed_off_by = $' + n + '::uuid');
          values.push(actor.employeeId);
          n += 1;
        }
      }
      if (sets.length === 0) return;
      sets.push('updated_at = now()');
      values.push(tenant.schoolId, id);
      await tx.$executeRawUnsafe(
        `UPDATE hr_appraisals SET ${sets.join(', ')} ` +
          `WHERE school_id = $${n}::uuid AND id = $${n + 1}::uuid`,
        ...values,
      );
    });
    // Re-read AFTER commit (see AppraisalCycleService.create fix).
    return this.getById(id, actor);
  }

  /** Assembles the full appraisal DTO including goals + observations
   * + comments. Comment + observation visibility is filtered by
   * whether the caller is admin/appraiser or the appraisee. */
  private async assembleDto(
    client: { $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown> },
    row: AppraisalRow,
    isAdmin: boolean,
    actor: ResolvedActor,
  ): Promise<AppraisalDto> {
    const isOwner = actor.employeeId !== null && actor.employeeId === row.employee_id;
    const goalRows = (await client.$queryRawUnsafe(
      SELECT_GOAL + 'WHERE appraisal_id = $1::uuid ORDER BY sort_order, created_at',
      row.id,
    )) as GoalRow[];
    // Observations attached to this appraisal — admins see all, the
    // appraisee sees only those NOT marked is_locked=false (i.e.
    // they see the locked / final ones; draft notes from observers
    // are hidden until lock — service-side, mirroring the Cycle 11
    // session-notes pattern).
    const obsWhere =
      isAdmin || isOwner
        ? 'WHERE o.appraisal_id = $1::uuid ORDER BY o.observation_date DESC'
        : 'WHERE o.appraisal_id = $1::uuid AND o.is_locked = true ORDER BY o.observation_date DESC';
    const obsRows = (await client.$queryRawUnsafe(
      SELECT_OBSERVATION_BASE + obsWhere,
      row.id,
    )) as ObservationRow[];
    // Comments — admins see all, appraisee sees only is_visible_to_employee=true.
    const commentWhere = isAdmin
      ? 'WHERE c.appraisal_id = $1::uuid ORDER BY c.created_at'
      : 'WHERE c.appraisal_id = $1::uuid AND c.is_visible_to_employee = true ORDER BY c.created_at';
    const commentRows = (await client.$queryRawUnsafe(
      SELECT_COMMENT_BASE + commentWhere,
      row.id,
    )) as CommentRow[];
    return {
      id: row.id,
      cycleId: row.cycle_id,
      cycleName: row.cycle_name,
      cycleType: row.cycle_type as CycleType | null,
      employeeId: row.employee_id,
      employeeName:
        row.employee_first || row.employee_last
          ? [row.employee_first, row.employee_last].filter(Boolean).join(' ')
          : null,
      appraiserId: row.appraiser_id,
      appraiserName:
        row.appraiser_first || row.appraiser_last
          ? [row.appraiser_first, row.appraiser_last].filter(Boolean).join(' ')
          : null,
      schoolId: row.school_id,
      overallRating: row.overall_rating as AppraisalRating | null,
      selfReview: row.self_review,
      appraiserReview: row.appraiser_review,
      developmentPlan: row.development_plan,
      status: row.status as AppraisalStatus,
      signedOffAt: row.signed_off_at,
      signedOffBy: row.signed_off_by,
      signedOffByName:
        row.signed_off_by_first || row.signed_off_by_last
          ? [row.signed_off_by_first, row.signed_off_by_last].filter(Boolean).join(' ')
          : null,
      linkedApprovalId: row.linked_approval_id,
      goals: goalRows.map((g) => ({
        id: g.id,
        appraisalId: g.appraisal_id,
        goalText: g.goal_text,
        successCriteria: g.success_criteria,
        targetDate: g.target_date,
        progress: g.progress as GoalProgress,
        progressNotes: g.progress_notes,
        sortOrder: g.sort_order,
        createdAt: g.created_at,
      })),
      observations: obsRows.map((o) => this.observationRowToDto(o)),
      comments: commentRows.map((c) => ({
        id: c.id,
        appraisalId: c.appraisal_id,
        authorId: c.author_id,
        authorName:
          c.author_first || c.author_last
            ? [c.author_first, c.author_last].filter(Boolean).join(' ')
            : null,
        commentText: c.comment_text,
        isVisibleToEmployee: c.is_visible_to_employee,
        createdAt: c.created_at,
      })),
      createdAt: row.created_at,
    };
  }

  /** Internal helper — used by AppraisalCommentService + GoalService
   * to load + verify the parent appraisal still allows mutation. */
  async loadInternal(id: string): Promise<{
    id: string;
    employeeId: string;
    appraiserId: string | null;
    status: AppraisalStatus;
    schoolId: string;
  } | null> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT id::text AS id, employee_id::text AS employee_id, ' +
          '       appraiser_id::text AS appraiser_id, status, school_id::text AS school_id ' +
          'FROM hr_appraisals WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as Array<{
        id: string;
        employee_id: string;
        appraiser_id: string | null;
        status: string;
        school_id: string;
      }>;
      if (rows.length === 0) return null;
      const r = rows[0]!;
      return {
        id: r.id,
        employeeId: r.employee_id,
        appraiserId: r.appraiser_id,
        status: r.status as AppraisalStatus,
        schoolId: r.school_id,
      };
    });
  }

  private observationRowToDto(r: ObservationRow): LessonObservationDto {
    return {
      id: r.id,
      appraisalId: r.appraisal_id,
      schoolId: r.school_id,
      observerId: r.observer_id,
      observerName:
        r.observer_first || r.observer_last
          ? [r.observer_first, r.observer_last].filter(Boolean).join(' ')
          : null,
      observedEmployeeId: r.observed_employee_id,
      observedEmployeeName:
        r.observed_first || r.observed_last
          ? [r.observed_first, r.observed_last].filter(Boolean).join(' ')
          : null,
      observationDate: r.observation_date,
      observedClassLabel: r.observed_class_label,
      observedClassId: r.observed_class_id,
      durationMinutes: r.duration_minutes,
      overallGrade: r.overall_grade as AppraisalRating | null,
      strengths: r.strengths,
      areasForDevelopment: r.areas_for_development,
      notes: r.notes,
      isLocked: r.is_locked,
      lockedAt: r.locked_at,
      lockedBy: r.locked_by,
      createdAt: r.created_at,
    };
  }

  private async assertAdmin(actor: ResolvedActor): Promise<void> {
    if (await this.isAdmin(actor)) return;
    throw new ForbiddenException('Appraisal management requires hr-005:write or school admin.');
  }

  // REVIEW-P2-4c BLOCKING 1 — exposed (was private) so AppraisalGoalService
  // and AppraisalCommentService can run their own authorization checks
  // against the appraisal admin tier.
  async isAdmin(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'hr-005:write',
      'hr-005:admin',
    ]);
  }

  private isUniqueViolation(err: unknown): boolean {
    const e = err as { code?: string; meta?: { code?: string }; message?: string };
    if (!e) return false;
    if (e.code === 'P2010' && e.meta?.code === '23505') return true;
    if (typeof e.message === 'string' && /unique/i.test(e.message)) return true;
    return false;
  }
}

@Injectable()
export class AppraisalGoalService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly appraisals: AppraisalService,
  ) {}

  async create(
    appraisalId: string,
    input: CreateAppraisalGoalDto,
    actor: ResolvedActor,
  ): Promise<AppraisalGoalDto> {
    const parent = await this.appraisals.loadInternal(appraisalId);
    if (!parent) throw new NotFoundException('Appraisal not found');
    if (parent.status === 'SIGNED_OFF') {
      throw new BadRequestException('Cannot add goals to a SIGNED_OFF appraisal.');
    }
    // REVIEW-P2-4c BLOCKING 1 — actor-aware authorization. Goal
    // authoring is permitted to admin/appraiser; the appraisee can
    // propose goals on their OWN appraisal in DRAFT/IN_REVIEW.
    // Anyone unrelated to the appraisal (e.g. a Teacher with
    // hr-005:read but not the appraisee or appraiser) gets a
    // collapsed 404 to avoid leaking the existence of the row.
    await this.assertCanMutateGoal(parent, actor);
    const id = generateId();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO hr_appraisal_goals ' +
          '(id, appraisal_id, goal_text, success_criteria, target_date, sort_order) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5::date, $6)',
        id,
        appraisalId,
        input.goalText,
        input.successCriteria ?? null,
        input.targetDate ?? null,
        input.sortOrder ?? 0,
      );
      const rows = (await tx.$queryRawUnsafe(
        SELECT_GOAL + 'WHERE id = $1::uuid LIMIT 1',
        id,
      )) as GoalRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  async patch(
    id: string,
    input: UpdateAppraisalGoalDto,
    actor: ResolvedActor,
  ): Promise<AppraisalGoalDto> {
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id, appraisal_id::text AS appraisal_id FROM hr_appraisal_goals WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string; appraisal_id: string }>;
      if (lock.length === 0) throw new NotFoundException('Goal not found');
      const parent = await this.appraisals.loadInternal(lock[0]!.appraisal_id);
      if (!parent) throw new NotFoundException('Parent appraisal not found');
      if (parent.status === 'SIGNED_OFF') {
        throw new BadRequestException('Cannot edit goals on a SIGNED_OFF appraisal.');
      }
      // REVIEW-P2-4c BLOCKING 1 — same actor-aware gate as create().
      await this.assertCanMutateGoal(parent, actor);
      const sets: string[] = [];
      const values: unknown[] = [];
      let n = 1;
      const push = (col: string, value: unknown, cast?: string) => {
        sets.push(`${col} = $${n}${cast ? `::${cast}` : ''}`);
        values.push(value);
        n += 1;
      };
      if (input.goalText !== undefined) push('goal_text', input.goalText);
      if (input.successCriteria !== undefined) push('success_criteria', input.successCriteria);
      if (input.targetDate !== undefined) push('target_date', input.targetDate, 'date');
      if (input.progress !== undefined) push('progress', input.progress);
      if (input.progressNotes !== undefined) push('progress_notes', input.progressNotes);
      if (sets.length === 0) {
        const rows = (await tx.$queryRawUnsafe(
          SELECT_GOAL + 'WHERE id = $1::uuid LIMIT 1',
          id,
        )) as GoalRow[];
        return this.rowToDto(rows[0]!);
      }
      sets.push('updated_at = now()');
      values.push(id);
      await tx.$executeRawUnsafe(
        `UPDATE hr_appraisal_goals SET ${sets.join(', ')} WHERE id = $${n}::uuid`,
        ...values,
      );
      const rows = (await tx.$queryRawUnsafe(
        SELECT_GOAL + 'WHERE id = $1::uuid LIMIT 1',
        id,
      )) as GoalRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  /**
   * Authorization for goal mutation. The mutation matrix:
   *   - admin (school admin OR hr-005:write/admin) — always allowed.
   *   - appraiser (parent.appraiserId === actor.employeeId) — always allowed.
   *   - appraisee (parent.employeeId === actor.employeeId) — allowed
   *     only on DRAFT/IN_REVIEW (own appraisal).
   *   - everyone else — collapsed 404 to avoid leaking row existence
   *     (mirrors the P2C3 / Cycle 11 row-scope-don't-leak-existence
   *     convention).
   */
  private async assertCanMutateGoal(
    parent: { employeeId: string; appraiserId: string | null; status: string },
    actor: ResolvedActor,
  ): Promise<void> {
    const isAdmin = await this.appraisals.isAdmin(actor);
    if (isAdmin) return;
    const isOwner = actor.employeeId !== null && actor.employeeId === parent.employeeId;
    const isAppraiser = actor.employeeId !== null && parent.appraiserId === actor.employeeId;
    if (isAppraiser) return;
    if (isOwner && (parent.status === 'DRAFT' || parent.status === 'IN_REVIEW')) {
      return;
    }
    throw new NotFoundException('Appraisal not found');
  }

  private rowToDto(r: GoalRow): AppraisalGoalDto {
    return {
      id: r.id,
      appraisalId: r.appraisal_id,
      goalText: r.goal_text,
      successCriteria: r.success_criteria,
      targetDate: r.target_date,
      progress: r.progress as GoalProgress,
      progressNotes: r.progress_notes,
      sortOrder: r.sort_order,
      createdAt: r.created_at,
    };
  }
}

@Injectable()
export class AppraisalCommentService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly appraisals: AppraisalService,
  ) {}

  async create(
    appraisalId: string,
    input: CreateAppraisalCommentDto,
    actor: ResolvedActor,
  ): Promise<AppraisalCommentDto> {
    if (!actor.employeeId) {
      throw new ForbiddenException(
        'Only employees with an hr_employees row can post appraisal comments.',
      );
    }
    const parent = await this.appraisals.loadInternal(appraisalId);
    if (!parent) throw new NotFoundException('Appraisal not found');
    if (parent.status === 'SIGNED_OFF') {
      throw new BadRequestException('Cannot add comments to a SIGNED_OFF appraisal.');
    }
    // REVIEW-P2-4c BLOCKING 1 — actor-aware authorization. Only
    // admin / appraiser / appraisee may comment. PRIVATE comments
    // (is_visible_to_employee=false) are admin/appraiser only —
    // the appraisee cannot author a private note about themselves.
    const isAdmin = await this.appraisals.isAdmin(actor);
    const isOwner = actor.employeeId === parent.employeeId;
    const isAppraiser = parent.appraiserId !== null && actor.employeeId === parent.appraiserId;
    if (!isAdmin && !isOwner && !isAppraiser) {
      // Don't leak existence — mirrors the row-scope-don't-leak
      // convention from P2C3 / Cycle 11.
      throw new NotFoundException('Appraisal not found');
    }
    const isVisibleToEmployee = input.isVisibleToEmployee ?? false;
    if (!isVisibleToEmployee && !isAdmin && !isAppraiser) {
      throw new ForbiddenException(
        'Private comments (isVisibleToEmployee=false) are restricted to the appraiser or admin.',
      );
    }
    const id = generateId();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO hr_appraisal_comments ' +
          '(id, appraisal_id, author_id, comment_text, is_visible_to_employee) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)',
        id,
        appraisalId,
        actor.employeeId,
        input.commentText,
        isVisibleToEmployee,
      );
      const rows = (await tx.$queryRawUnsafe(
        SELECT_COMMENT_BASE + 'WHERE c.id = $1::uuid LIMIT 1',
        id,
      )) as CommentRow[];
      const r = rows[0]!;
      return {
        id: r.id,
        appraisalId: r.appraisal_id,
        authorId: r.author_id,
        authorName:
          r.author_first || r.author_last
            ? [r.author_first, r.author_last].filter(Boolean).join(' ')
            : null,
        commentText: r.comment_text,
        isVisibleToEmployee: r.is_visible_to_employee,
        createdAt: r.created_at,
      };
    });
  }
}

/**
 * LessonObservationService — sensitive observation records.
 *
 * P2-4c keystone: writes are gated on the new non-XXX-NNN
 * permission code `lesson_observation:write`, granted ONLY to
 * School Admin / Platform Admin via everyFunction. Generic Staff
 * (HR-005:write holders) can read observations attached to
 * appraisals they manage but cannot author them. Mirrors the
 * P2C3 student_counseling_record:read pattern.
 */
@Injectable()
export class LessonObservationService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
    private readonly appraisals: AppraisalService,
  ) {}

  async listForEmployee(employeeId: string, actor: ResolvedActor): Promise<LessonObservationDto[]> {
    // The observed employee can see their own locked observations
    // through the appraisal detail surface. The dedicated list is
    // admin/observer-only.
    const isAdmin = await this.isObservationAdmin(actor);
    if (!isAdmin && actor.employeeId !== employeeId) {
      throw new ForbiddenException('You can only view your own lesson observations.');
    }
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const where = isAdmin
        ? 'WHERE o.school_id = $1::uuid AND o.observed_employee_id = $2::uuid ORDER BY o.observation_date DESC'
        : 'WHERE o.school_id = $1::uuid AND o.observed_employee_id = $2::uuid AND o.is_locked = true ORDER BY o.observation_date DESC';
      const rows = (await client.$queryRawUnsafe(
        SELECT_OBSERVATION_BASE + where,
        tenant.schoolId,
        employeeId,
      )) as ObservationRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async create(
    input: CreateLessonObservationDto,
    actor: ResolvedActor,
  ): Promise<LessonObservationDto> {
    await this.assertObservationWrite(actor);
    if (!actor.employeeId) {
      throw new ForbiddenException(
        'Only employees with an hr_employees row can author lesson observations.',
      );
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Validate observed employee + optional appraisal in school.
      const emp = (await tx.$queryRawUnsafe(
        'SELECT id FROM hr_employees WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        input.observedEmployeeId,
      )) as Array<{ id: string }>;
      if (emp.length === 0) {
        throw new BadRequestException(
          'observedEmployeeId does not match an employee in this school.',
        );
      }
      if (input.appraisalId) {
        const parent = await this.appraisals.loadInternal(input.appraisalId);
        if (!parent) {
          throw new BadRequestException('appraisalId does not match an appraisal in this school.');
        }
        if (parent.status === 'SIGNED_OFF') {
          throw new BadRequestException('Cannot attach an observation to a SIGNED_OFF appraisal.');
        }
      }
      await tx.$executeRawUnsafe(
        'INSERT INTO hr_lesson_observations ' +
          '(id, appraisal_id, school_id, observer_id, observed_employee_id, ' +
          ' observation_date, observed_class_label, observed_class_id, duration_minutes, ' +
          ' overall_grade, strengths, areas_for_development, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::date, $7, $8::uuid, $9, $10, $11, $12, $13)',
        id,
        input.appraisalId ?? null,
        tenant.schoolId,
        actor.employeeId,
        input.observedEmployeeId,
        input.observationDate,
        input.observedClassLabel,
        input.observedClassId ?? null,
        input.durationMinutes ?? null,
        input.overallGrade ?? null,
        input.strengths ?? null,
        input.areasForDevelopment ?? null,
        input.notes ?? null,
      );
      const rows = (await tx.$queryRawUnsafe(
        SELECT_OBSERVATION_BASE + 'WHERE o.id = $1::uuid LIMIT 1',
        id,
      )) as ObservationRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  async patch(
    id: string,
    input: UpdateLessonObservationDto,
    actor: ResolvedActor,
  ): Promise<LessonObservationDto> {
    await this.assertObservationWrite(actor);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id, is_locked FROM hr_lesson_observations ' +
          'WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        id,
      )) as Array<{ id: string; is_locked: boolean }>;
      if (lock.length === 0) throw new NotFoundException('Observation not found');
      if (lock[0]!.is_locked) {
        throw new BadRequestException('Observation is locked and cannot be modified.');
      }
      const sets: string[] = [];
      const values: unknown[] = [];
      let n = 1;
      const push = (col: string, value: unknown) => {
        sets.push(`${col} = $${n}`);
        values.push(value);
        n += 1;
      };
      if (input.observedClassLabel !== undefined)
        push('observed_class_label', input.observedClassLabel);
      if (input.durationMinutes !== undefined) push('duration_minutes', input.durationMinutes);
      if (input.overallGrade !== undefined) push('overall_grade', input.overallGrade);
      if (input.strengths !== undefined) push('strengths', input.strengths);
      if (input.areasForDevelopment !== undefined)
        push('areas_for_development', input.areasForDevelopment);
      if (input.notes !== undefined) push('notes', input.notes);
      if (sets.length === 0) {
        const rows = (await tx.$queryRawUnsafe(
          SELECT_OBSERVATION_BASE + 'WHERE o.id = $1::uuid LIMIT 1',
          id,
        )) as ObservationRow[];
        return this.rowToDto(rows[0]!);
      }
      sets.push('updated_at = now()');
      values.push(tenant.schoolId, id);
      await tx.$executeRawUnsafe(
        `UPDATE hr_lesson_observations SET ${sets.join(', ')} ` +
          `WHERE school_id = $${n}::uuid AND id = $${n + 1}::uuid`,
        ...values,
      );
      const rows = (await tx.$queryRawUnsafe(
        SELECT_OBSERVATION_BASE + 'WHERE o.id = $1::uuid LIMIT 1',
        id,
      )) as ObservationRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  /** Lock the observation — irreversible by design (mirrors Cycle 11
   * session-notes locked pattern). Once locked the observed
   * employee can read it via the appraisal detail surface. */
  async lock(id: string, actor: ResolvedActor): Promise<LessonObservationDto> {
    await this.assertObservationWrite(actor);
    if (!actor.employeeId) {
      throw new ForbiddenException(
        'Only employees with an hr_employees row can lock lesson observations.',
      );
    }
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id, is_locked FROM hr_lesson_observations ' +
          'WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        id,
      )) as Array<{ id: string; is_locked: boolean }>;
      if (lock.length === 0) throw new NotFoundException('Observation not found');
      if (lock[0]!.is_locked) {
        throw new BadRequestException('Observation is already locked.');
      }
      await tx.$executeRawUnsafe(
        'UPDATE hr_lesson_observations SET is_locked = true, locked_at = now(), locked_by = $1::uuid, ' +
          'updated_at = now() WHERE id = $2::uuid',
        actor.employeeId,
        id,
      );
      const rows = (await tx.$queryRawUnsafe(
        SELECT_OBSERVATION_BASE + 'WHERE o.id = $1::uuid LIMIT 1',
        id,
      )) as ObservationRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  private async assertObservationWrite(actor: ResolvedActor): Promise<void> {
    if (await this.isObservationAdmin(actor)) return;
    throw new ForbiddenException(
      'Lesson observations require lesson_observation:write — granted only to school administrators.',
    );
  }

  /** lesson_observation:write is the keystone gate. Service-side
   * check mirrors P2C3 student_counseling_record:read pattern —
   * even hr-005:write holders cannot author observations unless
   * they ALSO hold lesson_observation:write (granted only via
   * everyFunction to School Admin / Platform Admin). */
  async isObservationAdmin(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'lesson_observation:write',
      'lesson_observation:admin',
    ]);
  }

  private rowToDto(r: ObservationRow): LessonObservationDto {
    return {
      id: r.id,
      appraisalId: r.appraisal_id,
      schoolId: r.school_id,
      observerId: r.observer_id,
      observerName:
        r.observer_first || r.observer_last
          ? [r.observer_first, r.observer_last].filter(Boolean).join(' ')
          : null,
      observedEmployeeId: r.observed_employee_id,
      observedEmployeeName:
        r.observed_first || r.observed_last
          ? [r.observed_first, r.observed_last].filter(Boolean).join(' ')
          : null,
      observationDate: r.observation_date,
      observedClassLabel: r.observed_class_label,
      observedClassId: r.observed_class_id,
      durationMinutes: r.duration_minutes,
      overallGrade: r.overall_grade as AppraisalRating | null,
      strengths: r.strengths,
      areasForDevelopment: r.areas_for_development,
      notes: r.notes,
      isLocked: r.is_locked,
      lockedAt: r.locked_at,
      lockedBy: r.locked_by,
      createdAt: r.created_at,
    };
  }
}
