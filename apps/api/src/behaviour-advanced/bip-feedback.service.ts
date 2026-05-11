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
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { IsArray, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * BIP Feedback DTOs.
 */
export class RequestBipFeedbackDto {
  @IsUUID()
  teacherEmployeeId!: string;
}

export class SubmitBipFeedbackDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  strategiesObserved?: string[];

  @IsOptional()
  @IsIn(['NOT_EFFECTIVE', 'SOMEWHAT_EFFECTIVE', 'EFFECTIVE', 'VERY_EFFECTIVE'])
  overallEffectiveness?: 'NOT_EFFECTIVE' | 'SOMEWHAT_EFFECTIVE' | 'EFFECTIVE' | 'VERY_EFFECTIVE';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  classroomObservations?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  recommendedAdjustments?: string;
}

export interface BipFeedbackResponseDto {
  id: string;
  planId: string;
  teacherId: string | null;
  teacherName: string | null;
  requestedBy: string | null;
  requestedByName: string | null;
  requestedAt: string;
  submittedAt: string | null;
  strategiesObserved: string[] | null;
  overallEffectiveness: string | null;
  classroomObservations: string | null;
  recommendedAdjustments: string | null;
}

interface FeedbackRow {
  id: string;
  plan_id: string;
  teacher_id: string | null;
  teacher_first: string | null;
  teacher_last: string | null;
  requested_by: string | null;
  requestor_first: string | null;
  requestor_last: string | null;
  requested_at: string;
  submitted_at: string | null;
  strategies_observed: string[] | null;
  overall_effectiveness: string | null;
  classroom_observations: string | null;
  recommended_adjustments: string | null;
}

const SELECT_BASE =
  'SELECT f.id::text AS id, f.plan_id::text AS plan_id, ' +
  'f.teacher_id::text AS teacher_id, ' +
  'tp.first_name AS teacher_first, tp.last_name AS teacher_last, ' +
  'f.requested_by::text AS requested_by, ' +
  'rp.first_name AS requestor_first, rp.last_name AS requestor_last, ' +
  'TO_CHAR(f.requested_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS requested_at, ' +
  'TO_CHAR(f.submitted_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS submitted_at, ' +
  'f.strategies_observed, f.overall_effectiveness, f.classroom_observations, f.recommended_adjustments ' +
  'FROM svc_bip_teacher_feedback f ' +
  'LEFT JOIN hr_employees te ON te.id = f.teacher_id ' +
  'LEFT JOIN platform.iam_person tp ON tp.id = te.person_id ' +
  'LEFT JOIN hr_employees re ON re.id = f.requested_by ' +
  'LEFT JOIN platform.iam_person rp ON rp.id = re.person_id ';

function fullName(first: string | null, last: string | null): string | null {
  if (first && last) return first + ' ' + last;
  return null;
}

function rowToDto(r: FeedbackRow): BipFeedbackResponseDto {
  return {
    id: r.id,
    planId: r.plan_id,
    teacherId: r.teacher_id,
    teacherName: fullName(r.teacher_first, r.teacher_last),
    requestedBy: r.requested_by,
    requestedByName: fullName(r.requestor_first, r.requestor_last),
    requestedAt: r.requested_at,
    submittedAt: r.submitted_at,
    strategiesObserved: r.strategies_observed,
    overallEffectiveness: r.overall_effectiveness,
    classroomObservations: r.classroom_observations,
    recommendedAdjustments: r.recommended_adjustments,
  };
}

/**
 * BIP Feedback Service (P2-14 Step 7).
 *
 * Extends the existing svc_bip_teacher_feedback table from Cycle 11 with
 * new endpoints. Counsellor requests feedback from a specific teacher
 * (POST /behaviour/bip/:planId/request-feedback). Teacher submits
 * (PATCH /behaviour/bip-feedback/:id). All read paths reuse the schema
 * partial UNIQUE on (plan_id, teacher_id) WHERE submitted_at IS NULL.
 *
 * No new table — leverages the Cycle 11 schema (which the Cycle 9
 * step 3 seed had already exercised) plus a new service surface for
 * the structured feedback workflow.
 */
@Injectable()
export class BipFeedbackService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  private async hasCounsellorScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'beh-002:write',
      'beh-002:admin',
    ]);
  }

  async listForPlan(planId: string): Promise<BipFeedbackResponseDto[]> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_BASE + 'WHERE f.plan_id = $1::uuid ORDER BY f.requested_at DESC',
        planId,
      )) as FeedbackRow[];
      return rows.map(rowToDto);
    });
  }

  async requestFeedback(
    planId: string,
    input: RequestBipFeedbackDto,
    actor: ResolvedActor,
  ): Promise<BipFeedbackResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors or admins can request BIP teacher feedback');
    }
    const requesterId = actor.employeeId;
    if (!requesterId) {
      throw new BadRequestException('Caller has no hr_employees row in this school.');
    }

    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        const plan = (await tx.$queryRawUnsafe(
          'SELECT id FROM svc_behavior_plans WHERE id = $1::uuid',
          planId,
        )) as Array<{ id: string }>;
        if (plan.length === 0) throw new NotFoundException('BIP plan not found');

        const teacher = (await tx.$queryRawUnsafe(
          'SELECT id FROM hr_employees WHERE id = $1::uuid',
          input.teacherEmployeeId,
        )) as Array<{ id: string }>;
        if (teacher.length === 0) {
          throw new BadRequestException('teacherEmployeeId does not match an employee');
        }

        await tx.$executeRawUnsafe(
          'INSERT INTO svc_bip_teacher_feedback (id, plan_id, teacher_id, requested_by, requested_at) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, now())',
          id,
          planId,
          input.teacherEmployeeId,
          requesterId,
        );
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('svc_bip_teacher_feedback_pending_uq')) {
        throw new ConflictException(
          'A pending feedback request already exists for this (plan, teacher) pair',
        );
      }
      throw err;
    }
    return this.getById(id);
  }

  async submit(
    id: string,
    input: SubmitBipFeedbackDto,
    actor: ResolvedActor,
  ): Promise<BipFeedbackResponseDto> {
    const teacherEmpId = actor.employeeId;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const row = (await tx.$queryRawUnsafe(
        'SELECT teacher_id::text AS teacher_id, submitted_at FROM svc_bip_teacher_feedback ' +
          'WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ teacher_id: string | null; submitted_at: string | null }>;
      const r = row[0];
      if (!r) throw new NotFoundException('BIP feedback not found');
      if (r.submitted_at !== null) {
        throw new BadRequestException('BIP feedback has already been submitted');
      }
      const isCounsellor = await this.hasCounsellorScope(actor);
      if (!isCounsellor && r.teacher_id !== teacherEmpId) {
        throw new ForbiddenException(
          'Only the assigned teacher (or counsellor/admin) can submit this feedback',
        );
      }
      await tx.$executeRawUnsafe(
        'UPDATE svc_bip_teacher_feedback SET ' +
          'submitted_at = now(), ' +
          'strategies_observed = COALESCE($1::text[], strategies_observed), ' +
          'overall_effectiveness = COALESCE($2, overall_effectiveness), ' +
          'classroom_observations = COALESCE($3, classroom_observations), ' +
          'recommended_adjustments = COALESCE($4, recommended_adjustments), ' +
          'updated_at = now() ' +
          'WHERE id = $5::uuid',
        input.strategiesObserved ?? null,
        input.overallEffectiveness ?? null,
        input.classroomObservations ?? null,
        input.recommendedAdjustments ?? null,
        id,
      );
    });
    return this.getById(id);
  }

  async getById(id: string): Promise<BipFeedbackResponseDto> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_BASE + 'WHERE f.id = $1::uuid LIMIT 1',
        id,
      )) as FeedbackRow[];
      const first = rows[0];
      if (!first) throw new NotFoundException('BIP feedback not found');
      return rowToDto(first);
    });
  }
}
