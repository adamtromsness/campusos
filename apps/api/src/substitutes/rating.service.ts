import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { generateId } from '@campusos/database';
import { CreateRatingDto, RatingResponseDto } from './dto/substitutes.dto';

interface RatingRow {
  id: string;
  assignment_id: string;
  rater_type: string;
  overall_score: string | null;
  professionalism: string | null;
  punctuality: string | null;
  comments: string | null;
  rated_at: string;
  rated_by: string | null;
}

const SELECT_RATING_BASE = `
  SELECT r.id::text AS id,
         r.assignment_id::text AS assignment_id,
         r.rater_type,
         r.overall_score::text AS overall_score,
         r.professionalism::text AS professionalism,
         r.punctuality::text AS punctuality,
         r.comments,
         TO_CHAR(r.rated_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS rated_at,
         r.rated_by::text AS rated_by
  FROM sub_ratings r
`;

/**
 * RatingService — P2-9b Step 7.
 *
 * Bidirectional ratings — SCHOOL_RATES_SUB plus SUB_RATES_SCHOOL.
 * UNIQUE(assignment_id, rater_type) caps each direction at one row per
 * assignment.
 *
 * Keystone: every SCHOOL_RATES_SUB insert re-materialises
 * platform_substitute_profiles.overall_rating as AVG of all
 * SCHOOL_RATES_SUB rows the substitute has received across all assignments.
 *
 * Authorisation:
 *   SCHOOL_RATES_SUB — admin only (the school's view of the substitute)
 *   SUB_RATES_SCHOOL — only the assigned substitute (or admin override)
 */
@Injectable()
export class RatingService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  async hasAdminScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'sch-004:write',
    ]);
  }

  async listForAssignment(
    assignmentId: string,
    actor: ResolvedActor,
  ): Promise<RatingResponseDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      // Visibility — the assignment must belong to this school + actor must
      // be admin OR the assigned substitute.
      const asgRows = (await client.$queryRawUnsafe(
        `SELECT a.id::text AS id, a.substitute_id::text AS substitute_id
         FROM sub_assignments a
         JOIN sub_job_postings j ON j.id = a.job_id
         WHERE a.id = $1::uuid AND j.school_id = $2::uuid`,
        assignmentId,
        tenant.schoolId,
      )) as Array<{ id: string; substitute_id: string }>;
      if (asgRows.length === 0) throw new NotFoundException('Assignment not found');

      if (!(await this.hasAdminScope(actor))) {
        if (!actor.personId) throw new NotFoundException('Assignment not found');
        const platform = this.tenantPrisma.getPlatformClient();
        const profile = await platform.substituteProfile.findUnique({
          where: { personId: actor.personId },
        });
        if (!profile || profile.id !== asgRows[0]!.substitute_id) {
          throw new NotFoundException('Assignment not found');
        }
      }

      const rows = (await client.$queryRawUnsafe(
        SELECT_RATING_BASE + ' WHERE r.assignment_id = $1::uuid ORDER BY r.rated_at DESC',
        assignmentId,
      )) as RatingRow[];
      return rows.map(this.rowToDto);
    });
  }

  async create(
    assignmentId: string,
    input: CreateRatingDto,
    actor: ResolvedActor,
  ): Promise<RatingResponseDto> {
    const tenant = getCurrentTenant();
    const platform = this.tenantPrisma.getPlatformClient();
    const isAdmin = await this.hasAdminScope(actor);

    // Validate scores in range
    for (const [k, v] of Object.entries({
      overallScore: input.overallScore,
      professionalism: input.professionalism,
      punctuality: input.punctuality,
    })) {
      if (v !== undefined && v !== null && (v < 1.0 || v > 5.0)) {
        throw new BadRequestException(`${k} must be between 1.0 and 5.0`);
      }
    }

    let subProfileId: string | null = null;
    if (actor.personId) {
      const profile = await platform.substituteProfile.findUnique({
        where: { personId: actor.personId },
      });
      subProfileId = profile?.id ?? null;
    }

    const ratedId = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Resolve assignment + ensure it belongs to this school
      const asgRows = (await tx.$queryRawUnsafe(
        `SELECT a.id::text AS id, a.substitute_id::text AS substitute_id, a.status
         FROM sub_assignments a
         JOIN sub_job_postings j ON j.id = a.job_id
         WHERE a.id = $1::uuid AND j.school_id = $2::uuid`,
        assignmentId,
        tenant.schoolId,
      )) as Array<{ id: string; substitute_id: string; status: string }>;
      if (asgRows.length === 0) throw new NotFoundException('Assignment not found');
      const asg = asgRows[0]!;

      // Authority
      if (input.raterType === 'SCHOOL_RATES_SUB') {
        if (!isAdmin) {
          throw new ForbiddenException('Only school admins can submit SCHOOL_RATES_SUB ratings.');
        }
      } else {
        if (!isAdmin && subProfileId !== asg.substitute_id) {
          throw new ForbiddenException(
            'Only the assigned substitute can submit a SUB_RATES_SCHOOL rating.',
          );
        }
      }

      // Refuse ratings on non-CHECKED_OUT assignments — work must have happened first.
      if (asg.status !== 'CHECKED_OUT') {
        throw new ConflictException(
          `Ratings can only be submitted on CHECKED_OUT assignments (current: ${asg.status}).`,
        );
      }

      const id = generateId();
      try {
        await tx.$executeRawUnsafe(
          `INSERT INTO sub_ratings (id, assignment_id, rater_type, overall_score, professionalism, punctuality, comments, rated_by, rated_at)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::uuid, now())`,
          id,
          assignmentId,
          input.raterType,
          input.overallScore ?? null,
          input.professionalism ?? null,
          input.punctuality ?? null,
          input.comments ?? null,
          actor.employeeId,
        );
      } catch (e) {
        if (
          (e as { code?: string; meta?: { code?: string } }).meta?.code === '23505' ||
          String(e).includes('sub_ratings_assignment_rater_uq')
        ) {
          throw new ConflictException(
            `A ${input.raterType} rating already exists for this assignment. PATCH the existing row instead.`,
          );
        }
        throw e;
      }

      // Return the assignment's substitute id so we can re-materialise outside
      return { id, substituteId: asg.substitute_id, raterType: input.raterType };
    });

    // Re-materialise overall_rating on SCHOOL_RATES_SUB inserts.
    if (ratedId.raterType === 'SCHOOL_RATES_SUB') {
      await this.rematerialiseOverallRating(ratedId.substituteId);
    }

    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_RATING_BASE + ' WHERE r.id = $1::uuid',
        ratedId.id,
      )) as RatingRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  /**
   * Recompute platform_substitute_profiles.overall_rating as AVG of all
   * SCHOOL_RATES_SUB rows for this substitute across every school.
   * Reads + writes the platform schema.
   */
  async rematerialiseOverallRating(substituteId: string): Promise<void> {
    const platform = this.tenantPrisma.getPlatformClient();
    // Cross-tenant aggregation — for now scope to the current tenant's
    // ratings only. Cross-tenant rating aggregation is a Phase 3 concern
    // because tenant search_path switching makes a global cross-tenant
    // AVG non-trivial; documented in P2C9-REVIEW-NOTES.md.
    const tenant = getCurrentTenant();
    const rows = (await platform.$queryRawUnsafe(
      `SELECT AVG(r.overall_score)::numeric(2,1) AS avg_rating, COUNT(*)::int AS rating_count
       FROM ${asTenantSchema(tenant.subdomain)}.sub_ratings r
       JOIN ${asTenantSchema(tenant.subdomain)}.sub_assignments a ON a.id = r.assignment_id
       WHERE a.substitute_id = $1::uuid AND r.rater_type = 'SCHOOL_RATES_SUB' AND r.overall_score IS NOT NULL`,
      substituteId,
    )) as Array<{ avg_rating: string | null; rating_count: number }>;
    const avg = rows[0]?.avg_rating ?? null;
    await platform.substituteProfile.update({
      where: { id: substituteId },
      data: { overallRating: avg ? avg : null },
    });
  }

  private rowToDto = (r: RatingRow): RatingResponseDto => ({
    id: r.id,
    assignmentId: r.assignment_id,
    raterType: r.rater_type as RatingResponseDto['raterType'],
    overallScore: r.overall_score,
    professionalism: r.professionalism,
    punctuality: r.punctuality,
    comments: r.comments,
    ratedAt: r.rated_at,
    ratedBy: r.rated_by,
  });
}

function asTenantSchema(subdomain: string): string {
  // Identifier — already validated elsewhere; quote for safety.
  return `"tenant_${subdomain.replace(/[^a-z0-9_]/gi, '')}"`;
}
