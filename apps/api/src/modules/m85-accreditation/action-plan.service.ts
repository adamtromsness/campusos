import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import { assertCoordinatorScope, assertStaffOrAdmin, assertStandardResolves } from './access';
import type {
  ActionPlanDto,
  ActionPlanStatus,
  CreateActionPlanDto,
  SubAction,
  UpdateActionPlanDto,
  UpdateSubActionDto,
} from './dto/accreditation.dto';

interface ActionPlanRow {
  id: string;
  school_id: string;
  standard_id: string;
  goal: string;
  actions: unknown;
  responsible_party: string;
  target_date: string;
  status: string;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function normaliseActions(input: unknown): SubAction[] {
  if (!Array.isArray(input)) return [];
  return input.map((raw, idx) => {
    const a = raw as Partial<SubAction>;
    if (!a || typeof a !== 'object') {
      throw new BadRequestException(`actions[${idx}] must be an object`);
    }
    const description = (a.description ?? '').toString().trim();
    const due_date = (a.due_date ?? '').toString().trim();
    const status = (a.status ?? 'PENDING').toString();
    if (!description) {
      throw new BadRequestException(`actions[${idx}].description is required`);
    }
    if (!due_date) {
      throw new BadRequestException(`actions[${idx}].due_date is required`);
    }
    if (!['PENDING', 'COMPLETED', 'OVERDUE'].includes(status)) {
      throw new BadRequestException(
        `actions[${idx}].status must be PENDING, COMPLETED, or OVERDUE`,
      );
    }
    return { description, due_date, status: status as SubAction['status'] };
  });
}

@Injectable()
export class ActionPlanService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  private toDto(row: ActionPlanRow): ActionPlanDto {
    const actions = normaliseActions(
      typeof row.actions === 'string' ? JSON.parse(row.actions) : row.actions,
    );
    return {
      id: row.id,
      schoolId: row.school_id,
      standardId: row.standard_id,
      goal: row.goal,
      actions,
      responsibleParty: row.responsible_party,
      targetDate: row.target_date,
      status: row.status as ActionPlanStatus,
      notes: row.notes,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * REVIEW-P2C23 BLOCKING 2 fix — school-scope the employee lookup so
   * a current-school action plan cannot reference a foreign-school
   * employee via `hr_employees.id` guessing. Adds the explicit
   * `school_id = tenant.schoolId` predicate; bogus or cross-school
   * UUIDs return 400 with the same friendly message.
   */
  private async assertEmployeeInTenant(employeeId: string): Promise<void> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT 1 AS ok FROM hr_employees
         WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        employeeId,
        tenant.schoolId,
      );
    })) as Array<{ ok: number }>;
    if (rows.length === 0) {
      throw new BadRequestException(
        `responsibleParty ${employeeId} does not match an employee in this school`,
      );
    }
  }

  async list(actor: ResolvedActor, status?: string): Promise<ActionPlanDto[]> {
    assertStaffOrAdmin(actor, 'Listing action plans');
    const tenant = getCurrentTenant();
    const args: unknown[] = [tenant.schoolId];
    let where = 'school_id = $1::uuid';
    if (status) {
      args.push(status);
      where += ' AND status = $2';
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, standard_id::text AS standard_id,
                goal, actions, responsible_party::text AS responsible_party,
                target_date::text AS target_date, status, notes,
                created_by::text AS created_by,
                created_at::text AS created_at,
                updated_at::text AS updated_at
         FROM acc_action_plans
         WHERE ${where}
         ORDER BY target_date ASC`,
        ...args,
      );
    })) as ActionPlanRow[];
    return rows.map((r) => this.toDto(r));
  }

  async getById(actor: ResolvedActor, id: string): Promise<ActionPlanDto> {
    assertStaffOrAdmin(actor, 'Reading an action plan');
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, standard_id::text AS standard_id,
                goal, actions, responsible_party::text AS responsible_party,
                target_date::text AS target_date, status, notes,
                created_by::text AS created_by,
                created_at::text AS created_at,
                updated_at::text AS updated_at
         FROM acc_action_plans
         WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      );
    })) as ActionPlanRow[];
    if (rows.length === 0) throw new NotFoundException('Action plan not found');
    return this.toDto(rows[0]!);
  }

  async create(actor: ResolvedActor, input: CreateActionPlanDto): Promise<ActionPlanDto> {
    await assertCoordinatorScope(actor, this.permCheck, 'Creating an action plan');
    const tenant = getCurrentTenant();

    await assertStandardResolves(this.tenantPrisma, input.standardId);
    await this.assertEmployeeInTenant(input.responsibleParty);
    const actions = normaliseActions(input.actions);

    const id = generateId();
    const initialStatus: ActionPlanStatus =
      new Date(input.targetDate) < new Date(new Date().toISOString().slice(0, 10))
        ? 'OVERDUE'
        : 'PLANNED';

    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        `INSERT INTO acc_action_plans (id, school_id, standard_id, goal, actions,
                                        responsible_party, target_date, status, notes, created_by)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6::uuid, $7::date, $8, $9, $10::uuid)`,
        id,
        tenant.schoolId,
        input.standardId,
        input.goal.trim(),
        JSON.stringify(actions),
        input.responsibleParty,
        input.targetDate,
        initialStatus,
        input.notes ?? null,
        actor.accountId,
      );
    });
    return this.getById(actor, id);
  }

  async update(
    actor: ResolvedActor,
    id: string,
    input: UpdateActionPlanDto,
  ): Promise<ActionPlanDto> {
    await assertCoordinatorScope(actor, this.permCheck, 'Updating an action plan');
    const tenant = getCurrentTenant();
    const existing = await this.getById(actor, id);

    if (input.responsibleParty) {
      await this.assertEmployeeInTenant(input.responsibleParty);
    }
    let actionsJson: string | null = null;
    if (input.actions !== undefined) {
      const normalised = normaliseActions(input.actions);
      actionsJson = JSON.stringify(normalised);
    }
    if (input.status && input.status !== existing.status) {
      const allowed: Record<ActionPlanStatus, ActionPlanStatus[]> = {
        PLANNED: ['IN_PROGRESS', 'COMPLETE', 'OVERDUE'],
        IN_PROGRESS: ['COMPLETE', 'OVERDUE', 'PLANNED'],
        OVERDUE: ['IN_PROGRESS', 'COMPLETE'],
        COMPLETE: [],
      };
      if (!allowed[existing.status].includes(input.status)) {
        throw new BadRequestException(
          `Cannot transition action plan from ${existing.status} to ${input.status}`,
        );
      }
    }

    const sets: string[] = [];
    const args: unknown[] = [];
    let p = 1;
    function set(col: string, value: unknown, cast?: string): void {
      sets.push(`${col} = $${p}${cast ? '::' + cast : ''}`);
      args.push(value);
      p += 1;
    }
    if (input.goal !== undefined) set('goal', input.goal.trim());
    if (actionsJson !== null) set('actions', actionsJson, 'jsonb');
    if (input.responsibleParty !== undefined)
      set('responsible_party', input.responsibleParty, 'uuid');
    if (input.targetDate !== undefined) set('target_date', input.targetDate, 'date');
    if (input.status !== undefined) set('status', input.status);
    if (input.notes !== undefined) set('notes', input.notes);
    sets.push('updated_at = now()');

    if (sets.length === 1) return existing;
    args.push(id, tenant.schoolId);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        `UPDATE acc_action_plans SET ${sets.join(', ')}
         WHERE id = $${p}::uuid AND school_id = $${p + 1}::uuid`,
        ...args,
      );
    });
    return this.getById(actor, id);
  }

  /**
   * Update an individual sub-action within the JSONB actions array.
   * Targets the entry by index (0-based). When all sub-actions are
   * COMPLETED, the parent plan auto-flips to COMPLETE.
   */
  async updateSubAction(
    actor: ResolvedActor,
    id: string,
    input: UpdateSubActionDto,
  ): Promise<ActionPlanDto> {
    await assertCoordinatorScope(actor, this.permCheck, 'Updating an action plan sub-action');
    const existing = await this.getById(actor, id);
    if (input.index < 0 || input.index >= existing.actions.length) {
      throw new BadRequestException(`actions[${input.index}] does not exist`);
    }
    const next = existing.actions.map((a, i) => {
      if (i !== input.index) return a;
      return {
        description: input.description ?? a.description,
        due_date: input.due_date ?? a.due_date,
        status: input.status ?? a.status,
      };
    });

    const allComplete = next.every((a) => a.status === 'COMPLETED');
    const newStatus: ActionPlanStatus =
      allComplete && existing.status !== 'COMPLETE' ? 'COMPLETE' : existing.status;

    return this.update(actor, id, { actions: next, status: newStatus });
  }

  async delete(actor: ResolvedActor, id: string): Promise<void> {
    await assertCoordinatorScope(actor, this.permCheck, 'Deleting an action plan');
    const tenant = getCurrentTenant();
    const existing = await this.getById(actor, id); // 404 if not found
    if (existing.status === 'COMPLETE') {
      throw new BadRequestException('Cannot delete a COMPLETE action plan — keep for audit trail');
    }
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        `DELETE FROM acc_action_plans WHERE id = $1::uuid AND school_id = $2::uuid`,
        id,
        tenant.schoolId,
      );
    });
  }
}
