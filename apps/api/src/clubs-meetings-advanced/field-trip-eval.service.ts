import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  CreateFieldTripEvaluationDto,
  FieldTripEvaluationResponseDto,
  FieldTripEvaluationSummaryDto,
} from './dto/clubs-meetings-advanced.dto';

interface EvaluationRow {
  id: string;
  field_trip_id: string;
  evaluated_by: string;
  evaluated_by_name: string | null;
  overall_rating: number;
  educational_value_rating: number | null;
  logistics_rating: number | null;
  safety_rating: number | null;
  comments: string | null;
  would_recommend: boolean | null;
  created_at: Date;
}

const SELECT_EVAL =
  'SELECT e.id::text AS id, e.field_trip_id::text AS field_trip_id, ' +
  'e.evaluated_by::text AS evaluated_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM hr_employees em " +
  '  JOIN platform.iam_person ip ON ip.id = em.person_id ' +
  '  WHERE em.id = e.evaluated_by) AS evaluated_by_name, ' +
  'e.overall_rating, e.educational_value_rating, e.logistics_rating, e.safety_rating, ' +
  'e.comments, e.would_recommend, e.created_at ' +
  'FROM ext_field_trip_evaluations e ';

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  return (
    e?.code === '23505' || e?.meta?.code === '23505' || /unique constraint/i.test(e?.message ?? '')
  );
}

/**
 * FieldTripEvalService — P2-28b Step 4.
 *
 * Post-trip evaluations by staff. UNIQUE(field_trip_id, evaluated_by)
 * caps each evaluator at one row per trip — second attempt is
 * rejected with a friendly 400 that surfaces a PATCH path. The
 * schema-side CHECK constraints (1..5 rating bounds) are the
 * belt-and-braces.
 *
 * Authorisation: CLB-003:read for reads; CLB-003:write for the
 * write path. Refuses STUDENT and GUARDIAN at the service layer
 * since evaluation is a staff workflow.
 */
@Injectable()
export class FieldTripEvalService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private assertStaff(actor: ResolvedActor): void {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STUDENT' || actor.personType === 'GUARDIAN') {
      throw new ForbiddenException('Field-trip evaluation is staff-only');
    }
    if (!actor.employeeId) {
      throw new ForbiddenException('Staff actor must have an hr_employees row');
    }
  }

  async listForTrip(
    fieldTripId: string,
    actor: ResolvedActor,
  ): Promise<FieldTripEvaluationResponseDto[]> {
    this.assertStaff(actor);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_EVAL + 'WHERE e.field_trip_id = $1::uuid ORDER BY e.created_at DESC',
        fieldTripId,
      );
    })) as EvaluationRow[];
    return rows.map((r) => this.rowToDto(r));
  }

  async summary(fieldTripId: string, actor: ResolvedActor): Promise<FieldTripEvaluationSummaryDto> {
    this.assertStaff(actor);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT COUNT(*)::int AS evaluation_count, ' +
          'AVG(overall_rating)::float AS avg_overall, ' +
          'AVG(educational_value_rating)::float AS avg_edu, ' +
          'AVG(logistics_rating)::float AS avg_log, ' +
          'AVG(safety_rating)::float AS avg_safety, ' +
          'COUNT(*) FILTER (WHERE would_recommend = true)::int AS recommend_count ' +
          'FROM ext_field_trip_evaluations WHERE field_trip_id = $1::uuid',
        fieldTripId,
      );
    })) as Array<{
      evaluation_count: number;
      avg_overall: number | null;
      avg_edu: number | null;
      avg_log: number | null;
      avg_safety: number | null;
      recommend_count: number;
    }>;
    const r = rows[0]!;
    return {
      fieldTripId,
      evaluationCount: r.evaluation_count,
      averageOverall: r.avg_overall,
      averageEducational: r.avg_edu,
      averageLogistics: r.avg_log,
      averageSafety: r.avg_safety,
      recommendCount: r.recommend_count,
    };
  }

  async create(
    fieldTripId: string,
    input: CreateFieldTripEvaluationDto,
    actor: ResolvedActor,
  ): Promise<FieldTripEvaluationResponseDto> {
    this.assertStaff(actor);
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO ext_field_trip_evaluations ' +
            '(id, field_trip_id, evaluated_by, overall_rating, educational_value_rating, logistics_rating, safety_rating, comments, would_recommend) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9)',
          id,
          fieldTripId,
          actor.employeeId,
          input.overallRating,
          input.educationalValueRating ?? null,
          input.logisticsRating ?? null,
          input.safetyRating ?? null,
          input.comments ?? null,
          input.wouldRecommend ?? null,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException(
          'You have already evaluated this trip. PATCH /field-trip-evaluations/<id> to update your rating.',
        );
      }
      throw err;
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_EVAL + 'WHERE e.id = $1::uuid', id);
    })) as EvaluationRow[];
    if (rows.length === 0) throw new NotFoundException('Evaluation not found');
    return this.rowToDto(rows[0]!);
  }

  private rowToDto(r: EvaluationRow): FieldTripEvaluationResponseDto {
    return {
      id: r.id,
      fieldTripId: r.field_trip_id,
      evaluatedBy: r.evaluated_by,
      evaluatedByName: r.evaluated_by_name,
      overallRating: r.overall_rating,
      educationalValueRating: r.educational_value_rating,
      logisticsRating: r.logistics_rating,
      safetyRating: r.safety_rating,
      comments: r.comments,
      wouldRecommend: r.would_recommend,
      createdAt: r.created_at.toISOString(),
    };
  }
}
