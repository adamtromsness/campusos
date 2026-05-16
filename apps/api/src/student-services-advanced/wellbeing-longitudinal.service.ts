import { ForbiddenException, Injectable } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { getCurrentTenant } from '../tenant/tenant.context';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  StudentLongitudinalResponseDto,
  WellbeingLongitudinalRowDto,
  WellbeingTrend,
} from './dto/student-services-advanced.dto';

interface SourceAggregate {
  student_id: string;
  domain: string;
  avg_score: string | null;
  checkin_count: string;
  flagged_count: string;
}

interface LongitudinalRow {
  id: string;
  student_id: string;
  student_name: string | null;
  school_id: string;
  academic_year: string;
  domain: string;
  avg_score: string | null;
  trend: string;
  checkin_count: number;
  flagged_count: number;
  counsellor_notes: string | null;
  materialised_at: Date;
}

const SELECT_BASE =
  'SELECT l.id::text AS id, l.student_id::text AS student_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) " +
  '  FROM sis_students s JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
  '  JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
  '  WHERE s.id = l.student_id) AS student_name, ' +
  'l.school_id::text AS school_id, l.academic_year, l.domain, ' +
  'l.avg_score::text AS avg_score, l.trend, l.checkin_count, l.flagged_count, ' +
  'l.counsellor_notes, l.materialised_at ' +
  'FROM svc_wellbeing_longitudinal l ';

/**
 * WellbeingLongitudinalService — P2-28c annual aggregation across
 * academic years. Materialises per-(student, academic_year, domain)
 * average scores and trend from svc_wellbeing_responses. Reads are
 * staff + admin only; the materialised rows carry no individual
 * check-in data — only aggregated domain scores per academic year
 * and the trend direction relative to the prior year.
 *
 * The materialisation walks svc_wellbeing_responses joined to
 * svc_wellbeing_questions for the domain label and to svc_wellbeing
 * _checkins for the school filter. Numeric responses are averaged
 * within each domain. Flagged check-ins (flagged_for_follow_up=true)
 * contribute to flagged_count.
 *
 * Trend resolution: improving / stable / declining by comparing
 * avg_score against the previous year's row for the same (student,
 * domain). First-ever year defaults to STABLE.
 */
@Injectable()
export class WellbeingLongitudinalService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private assertStaff(actor: ResolvedActor): void {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STUDENT' || actor.personType === 'GUARDIAN') {
      throw new ForbiddenException('Wellbeing longitudinal trends are staff-only');
    }
  }

  async getForStudent(
    studentId: string,
    actor: ResolvedActor,
  ): Promise<StudentLongitudinalResponseDto> {
    this.assertStaff(actor);
    const tenant = getCurrentTenant();
    // REVIEW-P2C28 Round 1 BLOCKING 8 — read filters l.school_id +
    // joins through sis_students.school_id for defence in depth so
    // cross-school student UUIDs collapse to empty results.
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_BASE +
          'JOIN sis_students st ON st.id = l.student_id ' +
          'WHERE l.student_id = $1::uuid AND l.school_id = $2::uuid AND st.school_id = $2::uuid ' +
          'ORDER BY l.academic_year DESC, l.domain ASC',
        studentId,
        tenant.schoolId,
      );
    })) as LongitudinalRow[];

    const studentName = rows[0]?.student_name ?? null;
    return {
      studentId,
      studentName,
      rows: rows.map((r) => this.rowToDto(r)),
    };
  }

  async listForYear(
    academicYear: string,
    actor: ResolvedActor,
  ): Promise<WellbeingLongitudinalRowDto[]> {
    this.assertStaff(actor);
    const tenant = getCurrentTenant();
    // REVIEW-P2C28 Round 1 BLOCKING 8 — school predicate required.
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_BASE +
          'WHERE l.academic_year = $1 AND l.school_id = $2::uuid ' +
          'ORDER BY l.domain ASC, l.avg_score ASC NULLS LAST',
        academicYear,
        tenant.schoolId,
      );
    })) as LongitudinalRow[];
    return rows.map((r) => this.rowToDto(r));
  }

  /**
   * Materialise annual longitudinal rows from svc_wellbeing_responses.
   * Walks every student with at least one COMPLETED check-in in the
   * academic year, aggregates by domain, computes trend relative to
   * the prior year row (if any), and UPSERTs into svc_wellbeing
   * _longitudinal. Idempotent — re-running overwrites.
   *
   * Authorisation: school admin only (this is a heavy operation that
   * should be triggered once per academic year, usually by a cron or
   * a manual admin button).
   */
  async materialise(
    academicYear: string,
    actor: ResolvedActor,
  ): Promise<{ rowsWritten: number; academicYear: string }> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school admins can materialise longitudinal rollups');
    }
    const tenant = getCurrentTenant();

    let rowsWritten = 0;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const aggregates = (await tx.$queryRawUnsafe(
        'SELECT c.student_id::text AS student_id, q.domain, ' +
          'AVG(r.numeric_response)::numeric(3,1)::text AS avg_score, ' +
          'COUNT(DISTINCT c.id)::text AS checkin_count, ' +
          'COUNT(DISTINCT c.id) FILTER (WHERE c.flagged_for_follow_up)::text AS flagged_count ' +
          'FROM svc_wellbeing_checkins c ' +
          'JOIN svc_wellbeing_responses r ON r.checkin_id = c.id ' +
          'JOIN svc_wellbeing_questions q ON q.id = r.question_id ' +
          'WHERE c.school_id = $1::uuid AND c.completed_at IS NOT NULL ' +
          'AND r.numeric_response IS NOT NULL ' +
          "AND to_char(c.completed_at, 'YYYY-MM-DD') >= $2 || '-08-01' " +
          "AND to_char(c.completed_at, 'YYYY-MM-DD') < ($3 || '-08-01') " +
          'GROUP BY c.student_id, q.domain',
        tenant.schoolId,
        academicYear.slice(0, 4),
        String(Number(academicYear.slice(0, 4)) + 1),
      )) as SourceAggregate[];

      for (const agg of aggregates) {
        const trend = await this.computeTrend(
          tx,
          agg.student_id,
          agg.domain,
          academicYear,
          agg.avg_score,
        );
        const id = generateId();
        await tx.$executeRawUnsafe(
          'INSERT INTO svc_wellbeing_longitudinal (id, student_id, school_id, academic_year, ' +
            'domain, avg_score, trend, checkin_count, flagged_count, materialised_at) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::numeric, $7, $8::int, $9::int, now()) ' +
            'ON CONFLICT (student_id, academic_year, domain) DO UPDATE SET ' +
            'avg_score = EXCLUDED.avg_score, trend = EXCLUDED.trend, ' +
            'checkin_count = EXCLUDED.checkin_count, flagged_count = EXCLUDED.flagged_count, ' +
            'materialised_at = now(), updated_at = now()',
          id,
          agg.student_id,
          tenant.schoolId,
          academicYear,
          agg.domain,
          agg.avg_score,
          trend,
          agg.checkin_count,
          agg.flagged_count,
        );
        rowsWritten += 1;
      }
    });

    return { rowsWritten, academicYear };
  }

  private async computeTrend(
    tx: { $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown> },
    studentId: string,
    domain: string,
    academicYear: string,
    currentAvg: string | null,
  ): Promise<WellbeingTrend> {
    if (!currentAvg) return 'STABLE';
    const priorYear = String(Number(academicYear.slice(0, 4)) - 1) + academicYear.slice(4);
    const tenant = getCurrentTenant();
    // REVIEW-P2C28 Round 1 BLOCKING 8 — prior-year trend lookup must
    // carry the school predicate too. Cross-school prior-year rows
    // (e.g. a student who transferred in) should not contribute to
    // the trend calculation.
    const prior = (await tx.$queryRawUnsafe(
      'SELECT avg_score::text AS avg_score FROM svc_wellbeing_longitudinal ' +
        'WHERE student_id = $1::uuid AND domain = $2 AND academic_year = $3 ' +
        'AND school_id = $4::uuid LIMIT 1',
      studentId,
      domain,
      priorYear,
      tenant.schoolId,
    )) as Array<{ avg_score: string | null }>;
    if (prior.length === 0 || !prior[0]!.avg_score) return 'STABLE';
    const currentNum = Number(currentAvg);
    const priorNum = Number(prior[0]!.avg_score);
    const delta = currentNum - priorNum;
    if (delta > 0.3) return 'IMPROVING';
    if (delta < -0.3) return 'DECLINING';
    return 'STABLE';
  }

  private rowToDto(r: LongitudinalRow): WellbeingLongitudinalRowDto {
    return {
      id: r.id,
      studentId: r.student_id,
      studentName: r.student_name,
      schoolId: r.school_id,
      academicYear: r.academic_year,
      domain: r.domain as WellbeingLongitudinalRowDto['domain'],
      avgScore: r.avg_score === null ? null : Number(r.avg_score),
      trend: r.trend as WellbeingTrend,
      checkinCount: r.checkin_count,
      flaggedCount: r.flagged_count,
      counsellorNotes: r.counsellor_notes,
      materialisedAt: r.materialised_at.toISOString(),
    };
  }
}
