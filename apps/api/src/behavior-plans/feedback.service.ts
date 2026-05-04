import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { BehaviorPlanService, rowToFeedbackDto } from './behavior-plan.service';
import {
  FeedbackResponseDto,
  RequestFeedbackDto,
  SubmitFeedbackDto,
} from './dto/behavior-plan.dto';

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

interface PendingRow extends FeedbackRow {
  student_first: string | null;
  student_last: string | null;
  plan_type: string;
}

const SELECT_BASE =
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

/**
 * Detect a SQLSTATE 23505 unique-violation across Prisma's encodings —
 * `code='P2010'` (raw query path), `meta.code='23505'`, or the SQLSTATE
 * embedded in the message. Used to translate a partial-UNIQUE race on
 * `(plan_id, teacher_id) WHERE submitted_at IS NULL` into the same
 * friendly 400 the pre-flight surfaces (REVIEW-CYCLE9 MAJOR 3).
 */
function isUniqueViolation(err: unknown): boolean {
  const errObj = err as { code?: string; meta?: { code?: string }; message?: string };
  return (
    errObj?.code === 'P2010' ||
    errObj?.meta?.code === '23505' ||
    (typeof errObj?.message === 'string' && errObj.message.includes('23505'))
  );
}

const SELECT_PENDING = SELECT_BASE.replace(
  'FROM svc_bip_teacher_feedback f',
  'FROM svc_bip_teacher_feedback f ' +
    'JOIN svc_behavior_plans bp ON bp.id = f.plan_id ' +
    'JOIN sis_students s ON s.id = bp.student_id ' +
    'JOIN platform.platform_students sps ON sps.id = s.platform_student_id ' +
    'JOIN platform.iam_person sip ON sip.id = sps.person_id',
).replace(
  'f.classroom_observations, f.recommended_adjustments',
  'f.classroom_observations, f.recommended_adjustments, ' +
    'sip.first_name AS student_first, sip.last_name AS student_last, ' +
    'bp.plan_type',
);

@Injectable()
export class FeedbackService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly plans: BehaviorPlanService,
  ) {}

  /**
   * List all feedback rows for a plan. Visibility flows through the
   * parent plan via plans.getById() — non-readers 404 before any feedback
   * row leaks. Then `canSeeFeedback(actor)` short-circuits guardians and
   * students to an empty array — feedback rows carry private teacher
   * observations and effectiveness ratings the main plan service
   * already strips for those personas. Without this, a parent who holds
   * `BEH-002:read` (granted in Step 9 for the per-child Behaviour tab)
   * could read the rows on this dedicated endpoint that the main plan
   * service intentionally strips. (REVIEW-CYCLE9 BLOCKING fix.)
   */
  async listForPlan(planId: string, actor: ResolvedActor): Promise<FeedbackResponseDto[]> {
    await this.plans.getById(planId, actor);
    if (!(await this.plans.canSeeFeedback(actor))) {
      return [];
    }
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_BASE + 'WHERE f.plan_id = $1::uuid ORDER BY f.requested_at DESC',
        planId,
      )) as FeedbackRow[];
      return rows.map(rowToFeedbackDto);
    });
  }

  /**
   * Counsellor/admin opens a pending feedback row for a specific teacher.
   * Pre-flights the partial UNIQUE on (plan_id, teacher_id) WHERE
   * submitted_at IS NULL so the schema's INDEX never raises and the
   * counsellor sees a friendly 400 with the existing pending id.
   *
   * On success emits beh.bip.feedback_requested with the teacher's
   * resolved platform_users.id stamped as recipientAccountId so the
   * Cycle 7 TaskWorker (via the Step 3 seeded auto-task rule) lands a
   * task on the teacher's to-do list.
   */
  async requestFeedback(
    planId: string,
    input: RequestFeedbackDto,
    actor: ResolvedActor,
  ): Promise<FeedbackResponseDto> {
    if (!(await this.plans.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors and admins can request teacher feedback');
    }
    if (!actor.employeeId) {
      throw new ForbiddenException('Requesting staff member must have an employee record');
    }
    const plan = await this.plans.loadForChildWrite(planId, actor);
    const tenant = getCurrentTenant();
    const id = generateId();

    // Validate the supplied teacher_id resolves to a real hr_employees row
    // in this tenant + capture their platform_users.id for the Cycle 7
    // auto-task fan-out.
    const teacherInfo = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT he.id::text AS employee_id, ' +
          'pu.id::text AS account_id, ' +
          'p.first_name AS first_name, p.last_name AS last_name ' +
          'FROM hr_employees he ' +
          'JOIN platform.iam_person p ON p.id = he.person_id ' +
          'LEFT JOIN platform.platform_users pu ON pu.person_id = p.id ' +
          'WHERE he.id = $1::uuid LIMIT 1',
        input.teacherId,
      )) as Array<{
        employee_id: string;
        account_id: string | null;
        first_name: string;
        last_name: string;
      }>;
      if (rows.length === 0) {
        throw new BadRequestException('teacherId does not match an hr_employees row');
      }
      return rows[0]!;
    });

    // Partial UNIQUE pre-flight + INSERT inside a single tenant transaction
    // so the read sees the same snapshot the INSERT writes against. Under
    // concurrent requestFeedback calls for the same (plan, teacher) pair,
    // both txs can still pass the pre-check before either INSERT commits;
    // the try/catch on 23505 catches the race loser and surfaces the same
    // friendly 400 the pre-check uses (REVIEW-CYCLE9 MAJOR 3 — without
    // this, the loser sees a raw Prisma/Postgres unique-violation error).
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const conflict = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id FROM svc_bip_teacher_feedback ' +
          'WHERE plan_id = $1::uuid AND teacher_id = $2::uuid AND submitted_at IS NULL LIMIT 1',
        planId,
        input.teacherId,
      )) as Array<{ id: string }>;
      if (conflict.length > 0) {
        throw new BadRequestException(
          'A pending feedback request already exists for this teacher on this plan (' +
            conflict[0]!.id +
            '). Wait for the teacher to submit before opening another request.',
        );
      }
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO svc_bip_teacher_feedback ' +
            '(id, plan_id, teacher_id, requested_by, requested_at) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, now())',
          id,
          planId,
          input.teacherId,
          actor.employeeId,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new BadRequestException(
            'A pending feedback request already exists for this teacher on this plan. ' +
              'Wait for the teacher to submit before opening another request.',
          );
        }
        throw err;
      }
    });

    const teacherName = teacherInfo.first_name + ' ' + teacherInfo.last_name;
    void this.kafka.emit({
      topic: 'beh.bip.feedback_requested',
      key: id,
      sourceModule: 'behavior-plans',
      payload: {
        feedbackId: id,
        planId,
        schoolId: tenant.schoolId,
        studentId: plan.studentId,
        // Both flat student_name (snake_case for templates) and the
        // structured field; template-render.ts auto-flattens camelCase
        // → snake_case so callers can write {studentName} or {student_name}.
        studentName:
          plan.studentFirstName && plan.studentLastName
            ? plan.studentFirstName + ' ' + plan.studentLastName
            : null,
        planType: plan.planType,
        teacherId: input.teacherId,
        teacherName,
        // recipientAccountId / accountId carry the teacher's platform_users.id
        // so the seeded auto-task rule's null target_role resolves to this
        // recipient via the worker's payload.recipientAccountId fallback
        // (mirrors Cycle 8 tkt.ticket.assigned). Null when the teacher has
        // no portal account yet — the worker logs + skips.
        recipientAccountId: teacherInfo.account_id,
        accountId: teacherInfo.account_id,
        requesterId: actor.employeeId,
        requesterName: null,
        sourceRefId: id,
      },
      tenantId: tenant.schoolId,
      tenantSubdomain: tenant.subdomain,
    });

    return this.loadOrFail(id);
  }

  /**
   * Teacher submits their feedback OR admin overrides on behalf of a
   * teacher. Row scope: caller's employeeId must match the row's
   * teacher_id, OR caller is admin/counsellor. Stamps submitted_at = now()
   * in the same UPDATE so the partial UNIQUE on the pending filter
   * releases atomically and a fresh request can be opened against the
   * same (plan, teacher) pair afterward.
   */
  async submit(
    id: string,
    input: SubmitFeedbackDto,
    actor: ResolvedActor,
  ): Promise<FeedbackResponseDto> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT teacher_id::text AS teacher_id, submitted_at FROM svc_bip_teacher_feedback ' +
          'WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ teacher_id: string | null; submitted_at: string | null }>;
      if (lockRows.length === 0) throw new NotFoundException('Feedback ' + id);
      const row = lockRows[0]!;
      if (row.submitted_at !== null) {
        throw new BadRequestException(
          'Feedback has already been submitted. Open a new request for another round of observation.',
        );
      }
      const isCounsellor = await this.plans.hasCounsellorScope(actor);
      const isAssignedTeacher = !!actor.employeeId && actor.employeeId === row.teacher_id;
      if (!isCounsellor && !isAssignedTeacher) {
        throw new ForbiddenException(
          'Only the assigned teacher (or a counsellor) can submit this feedback',
        );
      }

      const sets: string[] = [
        'submitted_at = now()',
        'strategies_observed = $1::text[]',
        'overall_effectiveness = $2',
        'classroom_observations = $3',
        'recommended_adjustments = $4',
        'updated_at = now()',
      ];
      await tx.$executeRawUnsafe(
        'UPDATE svc_bip_teacher_feedback SET ' + sets.join(', ') + ' WHERE id = $5::uuid',
        input.strategiesObserved ?? null,
        input.overallEffectiveness ?? null,
        input.classroomObservations ?? null,
        input.recommendedAdjustments ?? null,
        id,
      );
    });
    return this.loadOrFail(id);
  }

  /**
   * Teacher's pending-feedback queue. Row-scoped to the calling employee.
   * Counsellors and admins see all pending across the tenant — useful for
   * the BIP admin UI to surface "still waiting on feedback" lists.
   */
  async listPending(actor: ResolvedActor): Promise<FeedbackResponseDto[]> {
    const isCounsellor = await this.plans.hasCounsellorScope(actor);
    if (!isCounsellor && !actor.employeeId) {
      // Non-staff personas reach this only if @RequirePermission misroutes;
      // defence in depth.
      return [];
    }
    const sql: string[] = [SELECT_PENDING, 'WHERE f.submitted_at IS NULL '];
    const params: unknown[] = [];
    let idx = 1;
    if (!isCounsellor) {
      sql.push('AND f.teacher_id = $' + idx + '::uuid ');
      params.push(actor.employeeId);
      idx++;
    }
    sql.push('ORDER BY f.requested_at DESC');

    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe<PendingRow[]>(
        sql.join(''),
        ...params,
      )) as PendingRow[];
      return rows.map((r) => {
        const dto = rowToFeedbackDto(r);
        dto.studentName =
          r.student_first && r.student_last ? r.student_first + ' ' + r.student_last : null;
        dto.planType = r.plan_type;
        return dto;
      });
    });
  }

  // ─── Internal helpers ────────────────────────────────────────

  private async loadOrFail(id: string): Promise<FeedbackResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<FeedbackRow[]>(SELECT_BASE + 'WHERE f.id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('Feedback ' + id);
    return rowToFeedbackDto(rows[0]!);
  }
}
