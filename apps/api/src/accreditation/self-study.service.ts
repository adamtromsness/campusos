import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import {
  assertCoordinatorScope,
  assertStaffOrAdmin,
  assertStandardResolves,
  isUniqueViolation,
} from './access';
import type {
  CreateSelfStudyRatingDto,
  SelfStudyRating,
  SelfStudyRatingDto,
  SelfStudySummaryDto,
} from './dto/accreditation.dto';
import { SiteVisitService } from './site-visit.service';

interface RatingRow {
  id: string;
  school_id: string;
  standard_id: string;
  cycle_id: string;
  rating: string;
  rationale: string;
  rated_by: string;
  rated_at: string;
}

@Injectable()
export class SelfStudyService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
    private readonly siteVisit: SiteVisitService,
  ) {}

  private toDto(row: RatingRow): SelfStudyRatingDto {
    return {
      id: row.id,
      schoolId: row.school_id,
      standardId: row.standard_id,
      cycleId: row.cycle_id,
      rating: row.rating as SelfStudyRating,
      rationale: row.rationale,
      ratedBy: row.rated_by,
      ratedAt: row.rated_at,
    };
  }

  async listForCycle(actor: ResolvedActor, cycleId: string): Promise<SelfStudyRatingDto[]> {
    assertStaffOrAdmin(actor, 'Listing self-study ratings');
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, standard_id::text AS standard_id,
                cycle_id, rating, rationale,
                rated_by::text AS rated_by,
                rated_at::text AS rated_at
         FROM acc_self_study_ratings
         WHERE school_id = $1::uuid AND cycle_id = $2
         ORDER BY rated_at DESC`,
        tenant.schoolId,
        cycleId,
      );
    })) as RatingRow[];
    return rows.map((r) => this.toDto(r));
  }

  async create(actor: ResolvedActor, input: CreateSelfStudyRatingDto): Promise<SelfStudyRatingDto> {
    await assertCoordinatorScope(actor, this.permCheck, 'Submitting a self-study rating');
    const tenant = getCurrentTenant();

    await assertStandardResolves(this.tenantPrisma, input.standardId);

    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          `INSERT INTO acc_self_study_ratings (id, school_id, standard_id, cycle_id, rating, rationale, rated_by, rated_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::uuid, now())`,
          id,
          tenant.schoolId,
          input.standardId,
          input.cycleId.trim(),
          input.rating,
          input.rationale.trim(),
          actor.accountId,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          `A rating already exists for standard ${input.standardId} in cycle ${input.cycleId} — PATCH the existing rating instead`,
        );
      }
      throw err;
    }

    // Best-effort readiness recompute — every rating affects the
    // (rating AND approved-evidence) intersection that drives the
    // cached readiness_score on acc_site_visit_prep.
    try {
      await this.siteVisit.recomputeReadinessForSchool(tenant.schoolId);
    } catch {
      // log-and-continue — recompute will retry on next read.
    }

    const out = await this.getOne(actor, id);
    if (!out) throw new NotFoundException('Rating not found after insert');
    return out;
  }

  async getOne(actor: ResolvedActor, id: string): Promise<SelfStudyRatingDto | null> {
    assertStaffOrAdmin(actor, 'Reading a self-study rating');
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, standard_id::text AS standard_id,
                cycle_id, rating, rationale,
                rated_by::text AS rated_by,
                rated_at::text AS rated_at
         FROM acc_self_study_ratings
         WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      );
    })) as RatingRow[];
    if (rows.length === 0) return null;
    return this.toDto(rows[0]!);
  }

  /**
   * Aggregate the cycle's ratings into a distribution + per-domain
   * breakdown. Domain comes from platform.acc_standards_platform via
   * a JOIN on standard_id; ratings against tenant custom standards
   * land in a synthetic "Custom" bucket.
   */
  async summary(actor: ResolvedActor, cycleId: string): Promise<SelfStudySummaryDto> {
    assertStaffOrAdmin(actor, 'Reading the self-study summary');
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT
            r.rating,
            COALESCE(p.domain, 'Custom') AS domain,
            COUNT(*)::int AS n
         FROM acc_self_study_ratings r
         LEFT JOIN platform.acc_standards_platform p ON p.id = r.standard_id
         WHERE r.school_id = $1::uuid AND r.cycle_id = $2
         GROUP BY r.rating, COALESCE(p.domain, 'Custom')`,
        tenant.schoolId,
        cycleId,
      );
    })) as Array<{ rating: string; domain: string; n: number }>;

    const totals = { EXEMPLARY: 0, ACCOMPLISHED: 0, DEVELOPING: 0, NOT_MET: 0 };
    const byDomainMap = new Map<
      string,
      { EXEMPLARY: number; ACCOMPLISHED: number; DEVELOPING: number; NOT_MET: number }
    >();

    for (const r of rows) {
      const rating = r.rating as keyof typeof totals;
      const n = Number(r.n);
      totals[rating] = (totals[rating] ?? 0) + n;
      if (!byDomainMap.has(r.domain)) {
        byDomainMap.set(r.domain, {
          EXEMPLARY: 0,
          ACCOMPLISHED: 0,
          DEVELOPING: 0,
          NOT_MET: 0,
        });
      }
      const bucket = byDomainMap.get(r.domain)!;
      bucket[rating] += n;
    }

    const totalRated = totals.EXEMPLARY + totals.ACCOMPLISHED + totals.DEVELOPING + totals.NOT_MET;
    const byDomain = Array.from(byDomainMap.entries())
      .map(([domain, bucket]) => ({ domain, ...bucket }))
      .sort((a, b) => a.domain.localeCompare(b.domain));

    return { cycleId, totals, totalRated, byDomain };
  }
}
