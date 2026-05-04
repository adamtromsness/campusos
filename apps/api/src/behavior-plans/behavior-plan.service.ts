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
import {
  BehaviorPlanResponseDto,
  CreateBehaviorPlanDto,
  FeedbackEffectiveness,
  FeedbackResponseDto,
  GoalProgress,
  GoalResponseDto,
  ListBehaviorPlansQueryDto,
  PlanStatus,
  PlanType,
  UpdateBehaviorPlanDto,
} from './dto/behavior-plan.dto';

interface PlanRow {
  id: string;
  school_id: string;
  student_id: string;
  student_first: string | null;
  student_last: string | null;
  student_grade: string | null;
  caseload_id: string | null;
  plan_type: string;
  status: string;
  created_by: string | null;
  creator_first: string | null;
  creator_last: string | null;
  review_date: string;
  review_meeting_id: string | null;
  target_behaviors: string[];
  replacement_behaviors: string[] | null;
  reinforcement_strategies: string[] | null;
  plan_document_s3_key: string | null;
  source_incident_id: string | null;
  created_at: string;
  updated_at: string;
}

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

interface FeedbackRow {
  id: string;
  plan_id: string;
  teacher_id: string | null;
  teacher_first: string | null;
  teacher_last: string | null;
  requested_by: string | null;
  requester_first: string | null;
  requester_last: string | null;
  requested_at: string;
  submitted_at: string | null;
  strategies_observed: string[] | null;
  overall_effectiveness: string | null;
  classroom_observations: string | null;
  recommended_adjustments: string | null;
}

const SELECT_PLAN_BASE =
  'SELECT p.id::text AS id, p.school_id::text AS school_id, ' +
  'p.student_id::text AS student_id, ' +
  'sip.first_name AS student_first, sip.last_name AS student_last, s.grade_level AS student_grade, ' +
  'p.caseload_id::text AS caseload_id, p.plan_type, p.status, ' +
  'p.created_by::text AS created_by, ' +
  'cp.first_name AS creator_first, cp.last_name AS creator_last, ' +
  "TO_CHAR(p.review_date, 'YYYY-MM-DD') AS review_date, " +
  'p.review_meeting_id::text AS review_meeting_id, ' +
  'p.target_behaviors, p.replacement_behaviors, p.reinforcement_strategies, ' +
  'p.plan_document_s3_key, p.source_incident_id::text AS source_incident_id, ' +
  'TO_CHAR(p.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(p.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM svc_behavior_plans p ' +
  'JOIN sis_students s ON s.id = p.student_id ' +
  'JOIN platform.platform_students sps ON sps.id = s.platform_student_id ' +
  'JOIN platform.iam_person sip ON sip.id = sps.person_id ' +
  'LEFT JOIN hr_employees ce ON ce.id = p.created_by ' +
  'LEFT JOIN platform.iam_person cp ON cp.id = ce.person_id ';

const SELECT_GOAL_BASE =
  'SELECT id::text AS id, plan_id::text AS plan_id, goal_text, ' +
  'baseline_frequency, target_frequency, measurement_method, progress, ' +
  "TO_CHAR(last_assessed_at, 'YYYY-MM-DD') AS last_assessed_at, " +
  'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM svc_behavior_plan_goals ';

const SELECT_FEEDBACK_BASE =
  'SELECT f.id::text AS id, f.plan_id::text AS plan_id, ' +
  'f.teacher_id::text AS teacher_id, ' +
  'tp.first_name AS teacher_first, tp.last_name AS teacher_last, ' +
  'f.requested_by::text AS requested_by, ' +
  'rp.first_name AS requester_first, rp.last_name AS requester_last, ' +
  'TO_CHAR(f.requested_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS requested_at, ' +
  'TO_CHAR(f.submitted_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS submitted_at, ' +
  'f.strategies_observed, f.overall_effectiveness, ' +
  'f.classroom_observations, f.recommended_adjustments ' +
  'FROM svc_bip_teacher_feedback f ' +
  'LEFT JOIN hr_employees te ON te.id = f.teacher_id ' +
  'LEFT JOIN platform.iam_person tp ON tp.id = te.person_id ' +
  'LEFT JOIN hr_employees re ON re.id = f.requested_by ' +
  'LEFT JOIN platform.iam_person rp ON rp.id = re.person_id ';

function fullName(first: string | null, last: string | null): string | null {
  if (first && last) return first + ' ' + last;
  return null;
}

function rowToGoalDto(r: GoalRow): GoalResponseDto {
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

export function rowToFeedbackDto(r: FeedbackRow): FeedbackResponseDto {
  return {
    id: r.id,
    planId: r.plan_id,
    teacherId: r.teacher_id,
    teacherName: fullName(r.teacher_first, r.teacher_last),
    requestedById: r.requested_by,
    requestedByName: fullName(r.requester_first, r.requester_last),
    requestedAt: r.requested_at,
    submittedAt: r.submitted_at,
    strategiesObserved: r.strategies_observed,
    overallEffectiveness: (r.overall_effectiveness as FeedbackEffectiveness) ?? null,
    classroomObservations: r.classroom_observations,
    recommendedAdjustments: r.recommended_adjustments,
    studentName: null,
    planType: null,
  };
}

@Injectable()
export class BehaviorPlanService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  // ─── Permission helpers ──────────────────────────────────────

  /**
   * Counsellor scope = caller can read/write across the tenant. Granted
   * to admins (sch-001:admin via everyFunction → also picks up beh-002:*)
   * and to staff who hold beh-002:write directly (counsellors). Teachers
   * with only beh-002:read fall through to the row-scoped path.
   */
  async hasCounsellorScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'beh-002:write',
    ]);
  }

  /**
   * Visibility predicate for the calling actor. Returns either an empty
   * fragment (counsellor scope, no filter), a STAFF teacher-only filter
   * scoped to students in the actor's classes via sis_class_teachers +
   * sis_enrollments, a GUARDIAN parent filter scoped to their own
   * children via sis_student_guardians + sis_guardians, or AND FALSE —
   * defence in depth even though the @RequirePermission gate already
   * 403s any persona without beh-002:read at the controller layer.
   */
  async buildVisibility(
    actor: ResolvedActor,
    start: number,
  ): Promise<{ fragment: string; param: string | null; consumed: 0 | 1 }> {
    if (await this.hasCounsellorScope(actor)) {
      return { fragment: '', param: null, consumed: 0 };
    }
    if (actor.personType === 'STAFF' && actor.employeeId) {
      // Teacher row scope: plans for students enrolled in classes the
      // calling employee teaches. Mirrors the IncidentService teacher
      // branch from Cycle 9 Step 4.
      return {
        fragment:
          'AND p.student_id IN (' +
          'SELECT e.student_id FROM sis_enrollments e ' +
          'JOIN sis_class_teachers ct ON ct.class_id = e.class_id ' +
          "WHERE e.status = 'ACTIVE' AND ct.teacher_employee_id = $" +
          start +
          '::uuid' +
          ') ',
        param: actor.employeeId,
        consumed: 1,
      };
    }
    if (actor.personType === 'GUARDIAN') {
      // Cycle 9 Step 9: parents see their own children's plans only.
      // Mirrors the IncidentService GUARDIAN branch — joins through
      // sis_student_guardians + sis_guardians keyed on actor.personId.
      // The Step 9 service-layer trimming additionally strips the
      // feedback[] array from the response (private teacher observations
      // about the child stay staff-side).
      return {
        fragment:
          'AND p.student_id IN (' +
          'SELECT sg.student_id FROM sis_student_guardians sg ' +
          'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
          'WHERE g.person_id = $' +
          start +
          '::uuid' +
          ') ',
        param: actor.personId,
        consumed: 1,
      };
    }
    return { fragment: 'AND FALSE ', param: null, consumed: 0 };
  }

  /**
   * Whether the calling actor is allowed to see the per-plan feedback
   * array. Counsellors and admins see all; teachers see all on plans
   * they can otherwise read; parents (GUARDIAN) get an empty array — the
   * feedback rows carry teacher observations about their child and are
   * staff-side per the Step 9 plan ("BIP summary visible read-only" — no
   * feedback timeline for parents).
   */
  private async canSeeFeedback(actor: ResolvedActor): Promise<boolean> {
    if (actor.personType === 'GUARDIAN') return false;
    return true;
  }

  // ─── Read paths ──────────────────────────────────────────────

  async list(
    query: ListBehaviorPlansQueryDto,
    actor: ResolvedActor,
  ): Promise<BehaviorPlanResponseDto[]> {
    const visibility = await this.buildVisibility(actor, 1);
    const sql: string[] = [SELECT_PLAN_BASE, 'WHERE 1=1 '];
    const params: unknown[] = [];
    let idx = 1;
    if (visibility.consumed === 1) {
      sql.push(visibility.fragment);
      params.push(visibility.param);
      idx++;
    } else if (visibility.fragment) {
      sql.push(visibility.fragment);
    }
    if (query.studentId) {
      sql.push('AND p.student_id = $' + idx + '::uuid ');
      params.push(query.studentId);
      idx++;
    }
    if (query.status) {
      sql.push('AND p.status = $' + idx + ' ');
      params.push(query.status);
      idx++;
    }
    if (query.planType) {
      sql.push('AND p.plan_type = $' + idx + ' ');
      params.push(query.planType);
      idx++;
    }
    sql.push(
      // ACTIVE first then DRAFT/REVIEW then EXPIRED — surfaces the live
      // plans at the top of the queue.
      "ORDER BY CASE p.status WHEN 'ACTIVE' THEN 0 WHEN 'REVIEW' THEN 1 WHEN 'DRAFT' THEN 2 ELSE 3 END, " +
        'p.review_date ASC, p.created_at DESC',
    );

    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<PlanRow[]>(sql.join(''), ...params);
    });
    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    // Bulk-load goals + feedback for all returned plans in one round-trip
    // each. Avoids the N+1 the per-plan loadOrFail path would incur.
    const [goalRows, feedbackRows] = await this.tenantPrisma.executeInTenantContext(
      async (client) => {
        return Promise.all([
          client.$queryRawUnsafe<GoalRow[]>(
            SELECT_GOAL_BASE + 'WHERE plan_id = ANY($1::uuid[]) ORDER BY created_at ASC',
            ids,
          ),
          client.$queryRawUnsafe<FeedbackRow[]>(
            SELECT_FEEDBACK_BASE + 'WHERE f.plan_id = ANY($1::uuid[]) ORDER BY f.requested_at DESC',
            ids,
          ),
        ]);
      },
    );

    const goalsByPlan = new Map<string, GoalResponseDto[]>();
    for (const g of goalRows) {
      const arr = goalsByPlan.get(g.plan_id) ?? [];
      arr.push(rowToGoalDto(g));
      goalsByPlan.set(g.plan_id, arr);
    }
    const feedbackByPlan = new Map<string, FeedbackResponseDto[]>();
    for (const f of feedbackRows) {
      const arr = feedbackByPlan.get(f.plan_id) ?? [];
      arr.push(rowToFeedbackDto(f));
      feedbackByPlan.set(f.plan_id, arr);
    }

    const includeFeedback = await this.canSeeFeedback(actor);
    return rows.map((r) =>
      this.rowToDto(
        r,
        goalsByPlan.get(r.id) ?? [],
        includeFeedback ? (feedbackByPlan.get(r.id) ?? []) : [],
      ),
    );
  }

  async getById(id: string, actor: ResolvedActor): Promise<BehaviorPlanResponseDto> {
    return this.loadOrFail(id, actor);
  }

  // ─── Write paths ─────────────────────────────────────────────

  async create(
    input: CreateBehaviorPlanDto,
    actor: ResolvedActor,
  ): Promise<BehaviorPlanResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException(
        'Only counsellors and admins can create behaviour intervention plans',
      );
    }
    if (!actor.employeeId) {
      throw new ForbiddenException('Creating staff member must have an employee record');
    }
    const tenant = getCurrentTenant();
    const id = generateId();

    // Validate the student exists in this tenant.
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid LIMIT 1',
        input.studentId,
      )) as Array<{ ok: number }>;
      if (rows.length === 0) {
        throw new BadRequestException('studentId does not match a student in this school');
      }

      // Validate the optional source_incident_id soft ref. Per ADR-001/020
      // the column has no DB-enforced FK to sis_discipline_incidents — the
      // service is the canonical validator before INSERT.
      if (input.sourceIncidentId) {
        const inc = (await client.$queryRawUnsafe(
          'SELECT 1 AS ok FROM sis_discipline_incidents WHERE id = $1::uuid LIMIT 1',
          input.sourceIncidentId,
        )) as Array<{ ok: number }>;
        if (inc.length === 0) {
          throw new BadRequestException(
            'sourceIncidentId does not match a discipline incident in this school',
          );
        }
      }
    });

    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO svc_behavior_plans ' +
          '(id, school_id, student_id, caseload_id, plan_type, status, created_by, ' +
          'review_date, target_behaviors, replacement_behaviors, reinforcement_strategies, source_incident_id) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'DRAFT', $6::uuid, $7::date, $8::text[], $9::text[], $10::text[], $11::uuid)",
        id,
        tenant.schoolId,
        input.studentId,
        input.caseloadId ?? null,
        input.planType,
        actor.employeeId,
        input.reviewDate,
        input.targetBehaviors,
        input.replacementBehaviors ?? null,
        input.reinforcementStrategies ?? null,
        input.sourceIncidentId ?? null,
      );
    });

    return this.loadOrFailNoAuth(id);
  }

  async update(
    id: string,
    input: UpdateBehaviorPlanDto,
    actor: ResolvedActor,
  ): Promise<BehaviorPlanResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException(
        'Only counsellors and admins can edit behaviour intervention plans',
      );
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (input.reviewDate !== undefined) {
      sets.push('review_date = $' + idx + '::date');
      params.push(input.reviewDate);
      idx++;
    }
    if (input.targetBehaviors !== undefined) {
      sets.push('target_behaviors = $' + idx + '::text[]');
      params.push(input.targetBehaviors);
      idx++;
    }
    if (input.replacementBehaviors !== undefined) {
      sets.push('replacement_behaviors = $' + idx + '::text[]');
      params.push(input.replacementBehaviors);
      idx++;
    }
    if (input.reinforcementStrategies !== undefined) {
      sets.push('reinforcement_strategies = $' + idx + '::text[]');
      params.push(input.reinforcementStrategies);
      idx++;
    }
    if (input.status !== undefined) {
      sets.push('status = $' + idx);
      params.push(input.status);
      idx++;
    }
    if (sets.length === 0) return this.loadOrFailNoAuth(id);
    sets.push('updated_at = now()');
    params.push(id);

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT status FROM svc_behavior_plans WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ status: string }>;
      if (lockRows.length === 0) throw new NotFoundException('Behaviour plan ' + id);
      const currentStatus = lockRows[0]!.status;
      // Generic PATCH never crosses into ACTIVE — that path is the
      // dedicated /activate endpoint so the partial UNIQUE keystone is
      // checked in one place. Same for EXPIRED via /expire.
      if (input.status !== undefined) {
        if (currentStatus === 'EXPIRED') {
          throw new BadRequestException('EXPIRED plans are read-only');
        }
        if (currentStatus === 'ACTIVE' && input.status !== 'REVIEW') {
          throw new BadRequestException(
            'Use /expire to retire an ACTIVE plan; use /activate to flip DRAFT → ACTIVE',
          );
        }
      }
      if (currentStatus === 'EXPIRED') {
        // Defence in depth: even non-status fields are read-only on
        // EXPIRED plans.
        throw new BadRequestException('EXPIRED plans are read-only');
      }
      await tx.$executeRawUnsafe(
        'UPDATE svc_behavior_plans SET ' + sets.join(', ') + ' WHERE id = $' + idx + '::uuid',
        ...params,
      );
    });

    return this.loadOrFailNoAuth(id);
  }

  /**
   * DRAFT → ACTIVE. Locks the plan row, verifies no other ACTIVE plan
   * exists for the same (student, plan_type), then flips. The schema's
   * partial UNIQUE INDEX on (student_id, plan_type) WHERE status='ACTIVE'
   * is the belt-and-braces; this pre-check surfaces a friendly 400 with
   * the existing plan id so the counsellor can find and expire it.
   */
  async activate(id: string, actor: ResolvedActor): Promise<BehaviorPlanResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors and admins can activate plans');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT status, student_id::text AS student_id, plan_type FROM svc_behavior_plans WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ status: string; student_id: string; plan_type: string }>;
      if (lockRows.length === 0) throw new NotFoundException('Behaviour plan ' + id);
      const row = lockRows[0]!;
      if (row.status === 'ACTIVE') {
        throw new BadRequestException('Plan is already ACTIVE');
      }
      if (row.status === 'EXPIRED') {
        throw new BadRequestException('Cannot activate an EXPIRED plan; create a new one instead');
      }
      // Pre-flight against the partial UNIQUE.
      const conflict = (await tx.$queryRawUnsafe(
        "SELECT id::text AS id FROM svc_behavior_plans WHERE student_id = $1::uuid AND plan_type = $2 AND status = 'ACTIVE' AND id <> $3::uuid LIMIT 1",
        row.student_id,
        row.plan_type,
        id,
      )) as Array<{ id: string }>;
      if (conflict.length > 0) {
        throw new BadRequestException(
          'Student already has an ACTIVE ' +
            row.plan_type +
            ' plan (' +
            conflict[0]!.id +
            '). Expire that plan before activating a new one.',
        );
      }
      await tx.$executeRawUnsafe(
        "UPDATE svc_behavior_plans SET status = 'ACTIVE', updated_at = now() WHERE id = $1::uuid",
        id,
      );
    });
    return this.loadOrFailNoAuth(id);
  }

  /**
   * ACTIVE | REVIEW | DRAFT → EXPIRED. EXPIRED is the terminal state and
   * the partial UNIQUE keystone releases on flip (the partial WHERE
   * filter on status='ACTIVE' no longer matches the row).
   */
  async expire(id: string, actor: ResolvedActor): Promise<BehaviorPlanResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors and admins can expire plans');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT status FROM svc_behavior_plans WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ status: string }>;
      if (lockRows.length === 0) throw new NotFoundException('Behaviour plan ' + id);
      if (lockRows[0]!.status === 'EXPIRED') {
        throw new BadRequestException('Plan is already EXPIRED');
      }
      await tx.$executeRawUnsafe(
        "UPDATE svc_behavior_plans SET status = 'EXPIRED', updated_at = now() WHERE id = $1::uuid",
        id,
      );
    });
    return this.loadOrFailNoAuth(id);
  }

  // ─── Internal helpers ────────────────────────────────────────

  /**
   * Public loader used by GoalService and FeedbackService to verify a
   * caller can act on a plan row before the dependent service writes
   * goals or feedback.
   */
  async loadForChildWrite(id: string, actor: ResolvedActor): Promise<BehaviorPlanResponseDto> {
    const plan = await this.loadOrFail(id, actor);
    if (plan.status === 'EXPIRED') {
      throw new BadRequestException('Cannot mutate goals or feedback on an EXPIRED plan');
    }
    return plan;
  }

  private async loadOrFail(id: string, actor: ResolvedActor): Promise<BehaviorPlanResponseDto> {
    const visibility = await this.buildVisibility(actor, 2);
    const sql =
      SELECT_PLAN_BASE +
      'WHERE p.id = $1::uuid ' +
      (visibility.fragment ? visibility.fragment : '');
    const params: unknown[] = [id];
    if (visibility.consumed === 1) params.push(visibility.param);

    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<PlanRow[]>(sql, ...params);
    });
    if (rows.length === 0) throw new NotFoundException('Behaviour plan ' + id);
    const [goals, feedback] = await this.loadChildren(id);
    const includeFeedback = await this.canSeeFeedback(actor);
    return this.rowToDto(rows[0]!, goals, includeFeedback ? feedback : []);
  }

  async loadOrFailNoAuth(id: string): Promise<BehaviorPlanResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<PlanRow[]>(SELECT_PLAN_BASE + 'WHERE p.id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('Behaviour plan ' + id);
    const [goals, feedback] = await this.loadChildren(id);
    return this.rowToDto(rows[0]!, goals, feedback);
  }

  private async loadChildren(planId: string): Promise<[GoalResponseDto[], FeedbackResponseDto[]]> {
    const [goals, feedback] = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return Promise.all([
        client.$queryRawUnsafe<GoalRow[]>(
          SELECT_GOAL_BASE + 'WHERE plan_id = $1::uuid ORDER BY created_at ASC',
          planId,
        ),
        client.$queryRawUnsafe<FeedbackRow[]>(
          SELECT_FEEDBACK_BASE + 'WHERE f.plan_id = $1::uuid ORDER BY f.requested_at DESC',
          planId,
        ),
      ]);
    });
    return [goals.map(rowToGoalDto), feedback.map(rowToFeedbackDto)];
  }

  private rowToDto(
    r: PlanRow,
    goals: GoalResponseDto[],
    feedback: FeedbackResponseDto[],
  ): BehaviorPlanResponseDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      studentId: r.student_id,
      studentFirstName: r.student_first,
      studentLastName: r.student_last,
      studentGradeLevel: r.student_grade,
      caseloadId: r.caseload_id,
      planType: r.plan_type as PlanType,
      status: r.status as PlanStatus,
      createdById: r.created_by,
      createdByName: fullName(r.creator_first, r.creator_last),
      reviewDate: r.review_date,
      reviewMeetingId: r.review_meeting_id,
      targetBehaviors: r.target_behaviors,
      replacementBehaviors: r.replacement_behaviors ?? [],
      reinforcementStrategies: r.reinforcement_strategies ?? [],
      planDocumentS3Key: r.plan_document_s3_key,
      sourceIncidentId: r.source_incident_id,
      goals,
      feedback,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
