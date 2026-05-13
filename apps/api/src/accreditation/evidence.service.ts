import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { assertCoordinatorScope, assertStaffOrAdmin, assertStandardResolves } from './access';
import type {
  CreateEvidenceDto,
  EvidenceItemDto,
  EvidenceStatus,
  ReviewEvidenceDto,
} from './dto/accreditation.dto';
import { SiteVisitService } from './site-visit.service';

interface EvidenceRow {
  id: string;
  school_id: string;
  standard_id: string;
  evidence_type: string;
  title: string;
  description: string | null;
  s3_key: string | null;
  url: string | null;
  metric_value: string | null;
  status: string;
  submitted_by: string;
  submitted_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  reviewer_notes: string | null;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class EvidenceService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
    private readonly siteVisit: SiteVisitService,
  ) {}

  private toDto(row: EvidenceRow): EvidenceItemDto {
    return {
      id: row.id,
      schoolId: row.school_id,
      standardId: row.standard_id,
      evidenceType: row.evidence_type as EvidenceItemDto['evidenceType'],
      title: row.title,
      description: row.description,
      s3Key: row.s3_key,
      url: row.url,
      metricValue: row.metric_value,
      status: row.status as EvidenceStatus,
      submittedBy: row.submitted_by,
      submittedAt: row.submitted_at,
      reviewedBy: row.reviewed_by,
      reviewedAt: row.reviewed_at,
      reviewerNotes: row.reviewer_notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async listForStandard(actor: ResolvedActor, standardId: string): Promise<EvidenceItemDto[]> {
    assertStaffOrAdmin(actor, 'Listing evidence for a standard');
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, standard_id::text AS standard_id,
                evidence_type, title, description, s3_key, url, metric_value, status,
                submitted_by::text AS submitted_by,
                submitted_at::text AS submitted_at,
                reviewed_by::text AS reviewed_by,
                reviewed_at::text AS reviewed_at,
                reviewer_notes,
                created_at::text AS created_at,
                updated_at::text AS updated_at
         FROM acc_evidence_items
         WHERE school_id = $1::uuid AND standard_id = $2::uuid
         ORDER BY created_at DESC`,
        tenant.schoolId,
        standardId,
      );
    })) as EvidenceRow[];
    return rows.map((r) => this.toDto(r));
  }

  async listByStatus(actor: ResolvedActor, status?: string): Promise<EvidenceItemDto[]> {
    assertStaffOrAdmin(actor, 'Listing evidence by status');
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
                evidence_type, title, description, s3_key, url, metric_value, status,
                submitted_by::text AS submitted_by,
                submitted_at::text AS submitted_at,
                reviewed_by::text AS reviewed_by,
                reviewed_at::text AS reviewed_at,
                reviewer_notes,
                created_at::text AS created_at,
                updated_at::text AS updated_at
         FROM acc_evidence_items
         WHERE ${where}
         ORDER BY created_at DESC LIMIT 200`,
        ...args,
      );
    })) as EvidenceRow[];
    return rows.map((r) => this.toDto(r));
  }

  async create(actor: ResolvedActor, input: CreateEvidenceDto): Promise<EvidenceItemDto> {
    assertStaffOrAdmin(actor, 'Submitting evidence');
    const tenant = getCurrentTenant();

    // SOFT INTEGRITY — validate standard_id resolves to either
    // platform or tenant custom framework. Throws 404 on miss.
    await assertStandardResolves(this.tenantPrisma, input.standardId);

    // Type-shape validation per the plan: DOCUMENT requires s3_key,
    // URL requires url, METRIC requires metric_value. OBSERVATION +
    // SURVEY accept either s3_key (uploaded write-up) or description.
    if (input.evidenceType === 'DOCUMENT' && !input.s3Key) {
      throw new BadRequestException('DOCUMENT evidence requires an s3Key');
    }
    if (input.evidenceType === 'URL' && !input.url) {
      throw new BadRequestException('URL evidence requires a url');
    }
    if (input.evidenceType === 'METRIC' && !input.metricValue) {
      throw new BadRequestException('METRIC evidence requires a metricValue');
    }

    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        `INSERT INTO acc_evidence_items (id, school_id, standard_id, evidence_type, title,
                                          description, s3_key, url, metric_value, status,
                                          submitted_by, submitted_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, 'DRAFT', $10::uuid, NULL)`,
        id,
        tenant.schoolId,
        input.standardId,
        input.evidenceType,
        input.title.trim(),
        input.description ?? null,
        input.s3Key ?? null,
        input.url ?? null,
        input.metricValue ?? null,
        actor.accountId,
      );
    });
    return (await this.getById(actor, id))!;
  }

  async getById(actor: ResolvedActor, id: string): Promise<EvidenceItemDto | null> {
    assertStaffOrAdmin(actor, 'Reading evidence');
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, standard_id::text AS standard_id,
                evidence_type, title, description, s3_key, url, metric_value, status,
                submitted_by::text AS submitted_by,
                submitted_at::text AS submitted_at,
                reviewed_by::text AS reviewed_by,
                reviewed_at::text AS reviewed_at,
                reviewer_notes,
                created_at::text AS created_at,
                updated_at::text AS updated_at
         FROM acc_evidence_items
         WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      );
    })) as EvidenceRow[];
    if (rows.length === 0) return null;
    return this.toDto(rows[0]!);
  }

  /**
   * Lifecycle transitions:
   *   DRAFT     → SUBMITTED  (any STAFF/admin owner — submission)
   *   SUBMITTED → APPROVED   (coordinator only — approval)
   *   SUBMITTED → REJECTED   (coordinator only — rejection)
   *
   * The schema's multi-column reviewed_chk pins reviewed_by +
   * reviewed_at populated when status in (APPROVED, REJECTED) and
   * NULL otherwise — so the UPDATE below stamps both atomically.
   *
   * Triggers a SiteVisitService.recomputeReadinessForSchool when
   * status flips to APPROVED so the cached site_visit_prep
   * readiness_score reflects the new evidence approval.
   */
  async review(
    actor: ResolvedActor,
    id: string,
    input: ReviewEvidenceDto,
  ): Promise<EvidenceItemDto> {
    const tenant = getCurrentTenant();
    const existing = await this.getById(actor, id);
    if (!existing) throw new NotFoundException('Evidence item not found');

    if (input.status === 'SUBMITTED') {
      // Submission allowed for the original submitter or any STAFF/admin.
      assertStaffOrAdmin(actor, 'Submitting evidence');
      if (existing.status !== 'DRAFT') {
        throw new BadRequestException(
          `Only DRAFT evidence can be moved to SUBMITTED (current: ${existing.status})`,
        );
      }
      await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE acc_evidence_items
           SET status = 'SUBMITTED',
               submitted_at = COALESCE(submitted_at, now()),
               updated_at = now()
           WHERE id = $1::uuid AND school_id = $2::uuid`,
          id,
          tenant.schoolId,
        );
      });
    } else {
      // APPROVED + REJECTED both require coordinator scope.
      await assertCoordinatorScope(actor, this.permCheck, 'Reviewing evidence');
      if (existing.status !== 'SUBMITTED') {
        throw new BadRequestException(
          `Only SUBMITTED evidence can be approved or rejected (current: ${existing.status})`,
        );
      }
      if (input.status === 'REJECTED' && !input.reviewerNotes) {
        throw new BadRequestException('reviewerNotes are required when rejecting evidence');
      }
      await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE acc_evidence_items
           SET status = $1,
               reviewed_by = $2::uuid,
               reviewed_at = now(),
               reviewer_notes = COALESCE($3, reviewer_notes),
               updated_at = now()
           WHERE id = $4::uuid AND school_id = $5::uuid`,
          input.status,
          actor.accountId,
          input.reviewerNotes ?? null,
          id,
          tenant.schoolId,
        );
      });
      // Trigger readiness recompute when an evidence flips to APPROVED
      // because the site visit cache depends on per-standard
      // (rating + APPROVED-evidence) intersection. Best-effort — a
      // recompute failure must not abort the review.
      if (input.status === 'APPROVED') {
        try {
          await this.siteVisit.recomputeReadinessForSchool(tenant.schoolId);
        } catch {
          // log-and-continue — readiness will refresh on next site
          // visit GET or rating submission.
        }
      }
    }

    const next = await this.getById(actor, id);
    if (!next) throw new NotFoundException('Evidence item not found');
    return next;
  }
}
