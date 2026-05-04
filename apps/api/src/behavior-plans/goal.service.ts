import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { BehaviorPlanService } from './behavior-plan.service';
import {
  CreateGoalDto,
  GoalProgress,
  GoalResponseDto,
  UpdateGoalDto,
} from './dto/behavior-plan.dto';

interface GoalRow {
  id: string;
  plan_id: string;
  goal_text: string;
  baseline_frequency: string | null;
  target_frequency: string | null;
  measurement_method: string | null;
  progress: string;
  last_assessed_at: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_BASE =
  'SELECT id::text AS id, plan_id::text AS plan_id, goal_text, ' +
  'baseline_frequency, target_frequency, measurement_method, progress, ' +
  "TO_CHAR(last_assessed_at, 'YYYY-MM-DD') AS last_assessed_at, " +
  'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM svc_behavior_plan_goals ';

function rowToDto(r: GoalRow): GoalResponseDto {
  return {
    id: r.id,
    planId: r.plan_id,
    goalText: r.goal_text,
    baselineFrequency: r.baseline_frequency,
    targetFrequency: r.target_frequency,
    measurementMethod: r.measurement_method,
    progress: r.progress as GoalProgress,
    lastAssessedAt: r.last_assessed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class GoalService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly plans: BehaviorPlanService,
  ) {}

  /**
   * List goals for a plan. Visibility flows through the parent plan:
   * touching plans.getById(id, actor) 404s for callers who can't see the
   * plan, before any goal rows are returned.
   */
  async listForPlan(planId: string, actor: ResolvedActor): Promise<GoalResponseDto[]> {
    await this.plans.getById(planId, actor);
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_BASE + 'WHERE plan_id = $1::uuid ORDER BY created_at ASC',
        planId,
      )) as GoalRow[];
      return rows.map(rowToDto);
    });
  }

  /**
   * Add a goal to a plan. Counsellor/admin only via
   * BehaviorPlanService.loadForChildWrite which 400s on EXPIRED plans.
   */
  async create(
    planId: string,
    input: CreateGoalDto,
    actor: ResolvedActor,
  ): Promise<GoalResponseDto> {
    if (!(await this.plans.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors and admins can add goals to a plan');
    }
    await this.plans.loadForChildWrite(planId, actor);
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO svc_behavior_plan_goals ' +
          '(id, plan_id, goal_text, baseline_frequency, target_frequency, measurement_method) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)',
        id,
        planId,
        input.goalText,
        input.baselineFrequency ?? null,
        input.targetFrequency ?? null,
        input.measurementMethod ?? null,
      );
    });
    return this.loadOrFail(id);
  }

  /**
   * Update a goal. When progress moves away from NOT_STARTED, last_assessed_at
   * is bumped to today (UTC date) so the BIP UI shows a fresh assessment
   * timestamp without the counsellor having to fill it in manually.
   */
  async update(id: string, input: UpdateGoalDto, actor: ResolvedActor): Promise<GoalResponseDto> {
    if (!(await this.plans.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors and admins can update goals');
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (input.goalText !== undefined) {
      sets.push('goal_text = $' + idx);
      params.push(input.goalText);
      idx++;
    }
    if (input.baselineFrequency !== undefined) {
      sets.push('baseline_frequency = $' + idx);
      params.push(input.baselineFrequency);
      idx++;
    }
    if (input.targetFrequency !== undefined) {
      sets.push('target_frequency = $' + idx);
      params.push(input.targetFrequency);
      idx++;
    }
    if (input.measurementMethod !== undefined) {
      sets.push('measurement_method = $' + idx);
      params.push(input.measurementMethod);
      idx++;
    }
    if (input.progress !== undefined) {
      sets.push('progress = $' + idx);
      params.push(input.progress);
      idx++;
      if (input.progress !== 'NOT_STARTED') {
        // Bump last_assessed_at to today on every active progress
        // transition. Counsellors can override later via a direct
        // patch if they want to record a historical assessment date.
        sets.push('last_assessed_at = CURRENT_DATE');
      }
    }
    if (sets.length === 0) return this.loadOrFail(id);
    sets.push('updated_at = now()');
    params.push(id);

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Lock the goal row + verify the parent plan is not EXPIRED before
      // mutating. JOIN on the parent so we can read the plan status in
      // the same statement and avoid a second round-trip.
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT g.id::text AS id, p.status AS plan_status, p.id::text AS plan_id FROM svc_behavior_plan_goals g ' +
          'JOIN svc_behavior_plans p ON p.id = g.plan_id ' +
          'WHERE g.id = $1::uuid FOR UPDATE OF g',
        id,
      )) as Array<{ id: string; plan_status: string; plan_id: string }>;
      if (lockRows.length === 0) throw new NotFoundException('Goal ' + id);
      if (lockRows[0]!.plan_status === 'EXPIRED') {
        throw new ForbiddenException('Cannot mutate goals on an EXPIRED plan');
      }
      await tx.$executeRawUnsafe(
        'UPDATE svc_behavior_plan_goals SET ' + sets.join(', ') + ' WHERE id = $' + idx + '::uuid',
        ...params,
      );
    });
    return this.loadOrFail(id);
  }

  /**
   * Remove a goal. Refused on EXPIRED plans — historical goals on an
   * expired plan are part of the audit trail.
   */
  async remove(id: string, actor: ResolvedActor): Promise<void> {
    if (!(await this.plans.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors and admins can delete goals');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT g.id::text AS id, p.status AS plan_status FROM svc_behavior_plan_goals g ' +
          'JOIN svc_behavior_plans p ON p.id = g.plan_id ' +
          'WHERE g.id = $1::uuid FOR UPDATE OF g',
        id,
      )) as Array<{ id: string; plan_status: string }>;
      if (rows.length === 0) throw new NotFoundException('Goal ' + id);
      if (rows[0]!.plan_status === 'EXPIRED') {
        throw new ForbiddenException('Cannot delete goals on an EXPIRED plan');
      }
      await tx.$executeRawUnsafe('DELETE FROM svc_behavior_plan_goals WHERE id = $1::uuid', id);
    });
  }

  // ─── Internal helpers ────────────────────────────────────────

  private async loadOrFail(id: string): Promise<GoalResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<GoalRow[]>(SELECT_BASE + 'WHERE id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('Goal ' + id);
    return rowToDto(rows[0]!);
  }
}
