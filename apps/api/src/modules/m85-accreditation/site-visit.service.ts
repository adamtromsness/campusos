import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { assertCoordinatorScope, assertStaffOrAdmin } from './access';
import type {
  CreateSiteVisitPrepDto,
  ReadinessReportDto,
  SiteVisitPrepDto,
  SiteVisitStatus,
  UpdateSiteVisitPrepDto,
} from './dto/accreditation.dto';

interface PrepRow {
  id: string;
  school_id: string;
  visit_date: string;
  accreditor_org: string;
  lead_contact_name: string | null;
  lead_contact_email: string | null;
  status: string;
  readiness_score: string | null;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class SiteVisitService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  private toDto(row: PrepRow): SiteVisitPrepDto {
    return {
      id: row.id,
      schoolId: row.school_id,
      visitDate: row.visit_date,
      accreditorOrg: row.accreditor_org,
      leadContactName: row.lead_contact_name,
      leadContactEmail: row.lead_contact_email,
      status: row.status as SiteVisitStatus,
      readinessScore: row.readiness_score === null ? null : Number(row.readiness_score),
      notes: row.notes,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async list(actor: ResolvedActor): Promise<SiteVisitPrepDto[]> {
    assertStaffOrAdmin(actor, 'Listing site visit preparations');
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id,
                visit_date::text AS visit_date,
                accreditor_org, lead_contact_name, lead_contact_email,
                status, readiness_score::text AS readiness_score, notes,
                created_by::text AS created_by,
                created_at::text AS created_at,
                updated_at::text AS updated_at
         FROM acc_site_visit_prep
         WHERE school_id = $1::uuid
         ORDER BY visit_date DESC`,
        tenant.schoolId,
      );
    })) as PrepRow[];
    return rows.map((r) => this.toDto(r));
  }

  async getById(actor: ResolvedActor, id: string): Promise<SiteVisitPrepDto> {
    assertStaffOrAdmin(actor, 'Reading a site visit preparation');
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id,
                visit_date::text AS visit_date,
                accreditor_org, lead_contact_name, lead_contact_email,
                status, readiness_score::text AS readiness_score, notes,
                created_by::text AS created_by,
                created_at::text AS created_at,
                updated_at::text AS updated_at
         FROM acc_site_visit_prep
         WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      );
    })) as PrepRow[];
    if (rows.length === 0) throw new NotFoundException('Site visit preparation not found');
    return this.toDto(rows[0]!);
  }

  async create(actor: ResolvedActor, input: CreateSiteVisitPrepDto): Promise<SiteVisitPrepDto> {
    await assertCoordinatorScope(actor, this.permCheck, 'Creating a site visit preparation');
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        `INSERT INTO acc_site_visit_prep (id, school_id, visit_date, accreditor_org,
                                           lead_contact_name, lead_contact_email,
                                           status, readiness_score, notes, created_by)
         VALUES ($1::uuid, $2::uuid, $3::date, $4, $5, $6, 'PREPARING', NULL, $7, $8::uuid)`,
        id,
        tenant.schoolId,
        input.visitDate,
        input.accreditorOrg.trim(),
        input.leadContactName ?? null,
        input.leadContactEmail ?? null,
        input.notes ?? null,
        actor.accountId,
      );
    });
    // Compute initial readiness so the row carries a real score.
    await this.recomputeReadinessForSchool(tenant.schoolId);
    return this.getById(actor, id);
  }

  /**
   * Status transitions:
   *   PREPARING → READY          (coordinator/admin)
   *   PREPARING → VISIT_COMPLETE (admin override only — visit closed early)
   *   READY     → VISIT_COMPLETE (after the visit)
   *   READY     → PREPARING      (rollback if a gap is discovered)
   */
  async update(
    actor: ResolvedActor,
    id: string,
    input: UpdateSiteVisitPrepDto,
  ): Promise<SiteVisitPrepDto> {
    await assertCoordinatorScope(actor, this.permCheck, 'Updating a site visit preparation');
    const tenant = getCurrentTenant();
    const existing = await this.getById(actor, id);

    if (input.status && input.status !== existing.status) {
      const allowed: Record<SiteVisitStatus, SiteVisitStatus[]> = {
        PREPARING: ['READY', 'VISIT_COMPLETE'],
        READY: ['PREPARING', 'VISIT_COMPLETE'],
        VISIT_COMPLETE: [],
      };
      if (!allowed[existing.status].includes(input.status)) {
        throw new BadRequestException(
          `Cannot transition from ${existing.status} to ${input.status}`,
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

    if (input.visitDate !== undefined) set('visit_date', input.visitDate, 'date');
    if (input.accreditorOrg !== undefined) set('accreditor_org', input.accreditorOrg.trim());
    if (input.leadContactName !== undefined) set('lead_contact_name', input.leadContactName);
    if (input.leadContactEmail !== undefined) set('lead_contact_email', input.leadContactEmail);
    if (input.status !== undefined) set('status', input.status);
    if (input.notes !== undefined) set('notes', input.notes);
    sets.push('updated_at = now()');

    if (sets.length === 1) return existing; // only updated_at — nothing changed
    args.push(id, tenant.schoolId);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        `UPDATE acc_site_visit_prep SET ${sets.join(', ')}
         WHERE id = $${p}::uuid AND school_id = $${p + 1}::uuid`,
        ...args,
      );
    });
    return this.getById(actor, id);
  }

  /**
   * KEYSTONE — readiness score formula.
   *
   *   readiness_score =
   *     ROUND(
   *       (count(standards with rating IN current cycle AND ≥1 APPROVED evidence)
   *        / total_adopted_standards) × 100
   *     )
   *
   * Where:
   *   - "adopted standards" = every platform.acc_standards_platform
   *     row whose framework has an active acc_school_framework_adoptions
   *     row in this school. Custom acc_frameworks rows count as a
   *     single standard each (per the SOFT INTEGRITY P2-23a contract).
   *   - "current cycle" is read from the most-recent
   *     acc_self_study_ratings.cycle_id seen for this school. If the
   *     school has no ratings yet, current_cycle defaults to the
   *     calendar-academic-year string `${this-fy}-${this-fy+1}`.
   *
   * Returns the report so callers can render gap lists. Side effect
   * — UPDATEs every acc_site_visit_prep row for this school whose
   * status is not VISIT_COMPLETE with the freshly-computed score.
   */
  async readinessForVisit(actor: ResolvedActor, visitId: string): Promise<ReadinessReportDto> {
    assertStaffOrAdmin(actor, 'Reading the site visit readiness report');
    const tenant = getCurrentTenant();
    const existing = await this.getById(actor, visitId);

    const cycle = await this.resolveCurrentCycle(tenant.schoolId);

    // Adopted platform standards (DISTINCT because a school could
    // adopt the same framework via duplicate is_active rows in some
    // edge case; the UNIQUE caps it but DISTINCT here is defensive).
    const platformStandards = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT s.id::text AS id, s.standard_code, s.domain
         FROM acc_school_framework_adoptions a
         JOIN platform.acc_standards_platform s ON s.framework_id = a.platform_framework_id
         WHERE a.school_id = $1::uuid AND a.is_active = true`,
        tenant.schoolId,
      );
    })) as Array<{ id: string; standard_code: string; domain: string }>;

    // Custom acc_frameworks rows count as one standard each.
    const customStandards = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, name
         FROM acc_frameworks
         WHERE school_id = $1::uuid AND is_active = true`,
        tenant.schoolId,
      );
    })) as Array<{ id: string; name: string }>;

    const allStandards: Array<{ id: string; standardCode: string; domain: string | null }> = [
      ...platformStandards.map((s) => ({
        id: s.id,
        standardCode: s.standard_code,
        domain: s.domain,
      })),
      ...customStandards.map((s) => ({
        id: s.id,
        standardCode: s.name,
        domain: null,
      })),
    ];

    if (allStandards.length === 0) {
      const out: ReadinessReportDto = {
        visitId,
        readinessScore: 0,
        totalAdoptedStandards: 0,
        standardsWithRating: 0,
        standardsWithApprovedEvidence: 0,
        standardsReady: 0,
        gaps: [],
      };
      // Cache 0 so the dashboard doesn't render NULL forever
      await this.persistScore(tenant.schoolId, visitId, 0, existing.status);
      return out;
    }

    const standardIds = allStandards.map((s) => s.id);

    const ratedRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT DISTINCT standard_id::text AS standard_id
         FROM acc_self_study_ratings
         WHERE school_id = $1::uuid AND cycle_id = $2
           AND standard_id = ANY($3::uuid[])`,
        tenant.schoolId,
        cycle,
        standardIds,
      );
    })) as Array<{ standard_id: string }>;
    const ratedSet = new Set(ratedRows.map((r) => r.standard_id));

    const evidencedRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT DISTINCT standard_id::text AS standard_id
         FROM acc_evidence_items
         WHERE school_id = $1::uuid AND status = 'APPROVED'
           AND standard_id = ANY($2::uuid[])`,
        tenant.schoolId,
        standardIds,
      );
    })) as Array<{ standard_id: string }>;
    const evidencedSet = new Set(evidencedRows.map((r) => r.standard_id));

    let ready = 0;
    const gaps: ReadinessReportDto['gaps'] = [];
    for (const s of allStandards) {
      const hasRating = ratedSet.has(s.id);
      const hasEvidence = evidencedSet.has(s.id);
      if (hasRating && hasEvidence) {
        ready += 1;
      } else {
        gaps.push({
          standardId: s.id,
          standardCode: s.standardCode,
          domain: s.domain,
          hasRating,
          hasApprovedEvidence: hasEvidence,
        });
      }
    }

    const score = Math.round((ready / allStandards.length) * 100);
    await this.persistScore(tenant.schoolId, visitId, score, existing.status);

    return {
      visitId,
      readinessScore: score,
      totalAdoptedStandards: allStandards.length,
      standardsWithRating: ratedSet.size,
      standardsWithApprovedEvidence: evidencedSet.size,
      standardsReady: ready,
      gaps,
    };
  }

  /**
   * Convenience used by EvidenceService + SelfStudyService whenever
   * an evidence approval or rating submission lands. Recomputes the
   * cached readiness_score on every active site_visit_prep row for
   * the school.
   */
  async recomputeReadinessForSchool(schoolId: string): Promise<void> {
    const cycle = await this.resolveCurrentCycle(schoolId);

    const platformStandards = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT s.id::text AS id
         FROM acc_school_framework_adoptions a
         JOIN platform.acc_standards_platform s ON s.framework_id = a.platform_framework_id
         WHERE a.school_id = $1::uuid AND a.is_active = true`,
        schoolId,
      );
    })) as Array<{ id: string }>;

    const customStandards = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id FROM acc_frameworks WHERE school_id = $1::uuid AND is_active = true`,
        schoolId,
      );
    })) as Array<{ id: string }>;

    const standardIds = [
      ...platformStandards.map((s) => s.id),
      ...customStandards.map((s) => s.id),
    ];
    if (standardIds.length === 0) return;

    const ratedRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT DISTINCT standard_id::text AS standard_id
         FROM acc_self_study_ratings
         WHERE school_id = $1::uuid AND cycle_id = $2
           AND standard_id = ANY($3::uuid[])`,
        schoolId,
        cycle,
        standardIds,
      );
    })) as Array<{ standard_id: string }>;
    const ratedSet = new Set(ratedRows.map((r) => r.standard_id));

    const evidencedRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT DISTINCT standard_id::text AS standard_id
         FROM acc_evidence_items
         WHERE school_id = $1::uuid AND status = 'APPROVED'
           AND standard_id = ANY($2::uuid[])`,
        schoolId,
        standardIds,
      );
    })) as Array<{ standard_id: string }>;
    const evidencedSet = new Set(evidencedRows.map((r) => r.standard_id));

    let ready = 0;
    for (const sid of standardIds) {
      if (ratedSet.has(sid) && evidencedSet.has(sid)) ready += 1;
    }
    const score = Math.round((ready / standardIds.length) * 100);

    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        `UPDATE acc_site_visit_prep SET readiness_score = $1, updated_at = now()
         WHERE school_id = $2::uuid AND status <> 'VISIT_COMPLETE'`,
        score,
        schoolId,
      );
    });
  }

  private async persistScore(
    schoolId: string,
    visitId: string,
    score: number,
    status: SiteVisitStatus,
  ): Promise<void> {
    if (status === 'VISIT_COMPLETE') return; // do not overwrite a closed visit's snapshot
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        `UPDATE acc_site_visit_prep SET readiness_score = $1, updated_at = now()
         WHERE id = $2::uuid AND school_id = $3::uuid`,
        score,
        visitId,
        schoolId,
      );
    });
  }

  private async resolveCurrentCycle(schoolId: string): Promise<string> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT cycle_id, MAX(rated_at) AS latest
         FROM acc_self_study_ratings
         WHERE school_id = $1::uuid
         GROUP BY cycle_id
         ORDER BY MAX(rated_at) DESC
         LIMIT 1`,
        schoolId,
      );
    })) as Array<{ cycle_id: string }>;
    if (rows.length > 0) return rows[0]!.cycle_id;
    const yr = new Date().getFullYear();
    return `${yr}-${yr + 1}`;
  }
}
