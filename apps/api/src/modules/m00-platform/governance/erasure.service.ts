import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { GovernanceAccess } from './access';
import type {
  CreateConsentDto,
  CreateErasureDto,
  CreatePrivacyNoticeDto,
  ConsentRecordDto,
  ErasureRequestDto,
  PrivacyNoticeDto,
  PseudonymisationLogDto,
  PseudonymiseAuditDto,
  PublishPrivacyNoticeDto,
  UpdateComplianceConfigDto,
  UpdateErasureDto,
  WithdrawConsentDto,
  ComplianceConfigDto,
} from './dto/governance.dto';

/**
 * ErasureService — GDPR Article 17 Right to Erasure +
 * **AUDIT LOG FIELD-LEVEL PSEUDONYMISATION (KEYSTONE).**
 *
 * Pseudonymise rewrites platform.platform_audit_log.metadata JSONB
 * for the data subject's rows, replacing identifier paths with the
 * opaque `psd_<token>` token, and writes one IMMUTABLE row per
 * (target_table, target_field) into dpo_pseudonymisation_log. The
 * pseudonymisation log has no UPDATE / no DELETE methods exposed at
 * the service layer — service-side discipline matches Cycle 8
 * tkt_ticket_activity + Cycle 10 hlth_health_access_log.
 */
@Injectable()
export class ErasureService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
    private readonly access: GovernanceAccess,
  ) {}

  /**
   * "DPO scope" = school admin OR (STAFF persona with dpo-004:write).
   * Parents and students hold dpo-004:write for self-service SAR
   * submission via SarService, but they MUST NOT see the erasure
   * register or the pseudonymisation log — those are DPO-internal.
   */
  async hasDpoScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    if (actor.personType !== 'STAFF') return false;
    const tenant = getCurrentTenant();
    return this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'dpo-004:write',
    ]);
  }

  private rowToErasureDto(r: Record<string, unknown>): ErasureRequestDto {
    return {
      id: r.id as string,
      schoolId: r.school_id as string,
      dataSubjectId: r.data_subject_id as string,
      requestedById: r.requested_by as string,
      requestDetails: (r.request_details as string | null) ?? null,
      status: r.status as ErasureRequestDto['status'],
      denialBasis: (r.denial_basis as string | null) ?? null,
      categoriesErased: (r.categories_erased as string[]) ?? [],
      categoriesRetained: (r.categories_retained as string[]) ?? [],
      categoriesPseudonymised: (r.categories_pseudonymised as string[]) ?? [],
      reviewedById: (r.reviewed_by as string | null) ?? null,
      completedAt: (r.completed_at as Date | null)?.toISOString() ?? null,
      notes: (r.notes as string | null) ?? null,
      createdAt: (r.created_at as Date).toISOString(),
      updatedAt: (r.updated_at as Date).toISOString(),
    };
  }

  async list(actor: ResolvedActor, args?: { status?: string }): Promise<ErasureRequestDto[]> {
    if (!(await this.hasDpoScope(actor))) {
      throw new ForbiddenException(
        'Erasure register access is restricted to the DPO scope (dpo-004:write).',
      );
    }
    const tenant = getCurrentTenant();
    const where: string[] = ['school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (args?.status) {
      where.push(`status = $${params.length + 1}`);
      params.push(args.status);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT * FROM dpo_erasure_requests WHERE ${where.join(' AND ')} ORDER BY created_at DESC`,
        ...params,
      );
    })) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToErasureDto(r));
  }

  async getById(actor: ResolvedActor, id: string): Promise<ErasureRequestDto> {
    if (!(await this.hasDpoScope(actor))) {
      throw new ForbiddenException(
        'Erasure register access is restricted to the DPO scope (dpo-004:write).',
      );
    }
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT * FROM dpo_erasure_requests WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      );
    })) as Array<Record<string, unknown>>;
    if (rows.length === 0) throw new NotFoundException(`Erasure request ${id} not found.`);
    return this.rowToErasureDto(rows[0]!);
  }

  async create(actor: ResolvedActor, input: CreateErasureDto): Promise<ErasureRequestDto> {
    if (!(await this.hasDpoScope(actor))) {
      throw new ForbiddenException('Only the DPO can register an erasure request (dpo-004:write).');
    }
    // REVIEW-CYCLE30 BLOCKING 3 — DPO cannot file an erasure against an
    // arbitrary platform.iam_person.id; must project into this tenant.
    await this.access.assertDataSubjectInCurrentTenant(input.dataSubjectId);
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO dpo_erasure_requests
         (id, school_id, data_subject_id, requested_by, request_details, status, notes)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'RECEIVED', $6)`,
        id,
        tenant.schoolId,
        input.dataSubjectId,
        actor.accountId,
        input.requestDetails ?? null,
        input.notes ?? null,
      );
    });
    return this.getById(actor, id);
  }

  async update(
    actor: ResolvedActor,
    id: string,
    input: UpdateErasureDto,
  ): Promise<ErasureRequestDto> {
    if (!(await this.hasDpoScope(actor))) {
      throw new ForbiddenException('Only the DPO can mutate erasure requests (dpo-004:write).');
    }
    const tenant = getCurrentTenant();
    // REVIEW-CYCLE30 MAJOR 8 — locked-row + status-safe transition.
    // Same pattern as SarService.update: SELECT … FOR UPDATE inside the
    // tx, validate the locked snapshot, apply the UPDATE in the same tx.
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockedRows = (await tx.$queryRawUnsafe(
        `SELECT status, completed_at FROM dpo_erasure_requests
          WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE`,
        id,
        tenant.schoolId,
      )) as Array<{ status: string; completed_at: Date | null }>;
      if (lockedRows.length === 0) throw new NotFoundException(`Erasure request ${id} not found.`);
      const lockedStatus = lockedRows[0]!.status;
      const lockedCompletedAt = lockedRows[0]!.completed_at;
      if (lockedStatus === 'COMPLETED' || lockedStatus === 'DENIED') {
        throw new BadRequestException(
          'An erasure request in COMPLETED or DENIED status is immutable.',
        );
      }
      const sets: string[] = [];
      const params: unknown[] = [];
      let i = 1;
      const push = (col: string, val: unknown, cast?: string) => {
        sets.push(`${col} = $${i}${cast ?? ''}`);
        params.push(val);
        i++;
      };
      let stampCompleted = false;
      if (input.status !== undefined) {
        push('status', input.status);
        if (
          input.status === 'COMPLETED' ||
          input.status === 'DENIED' ||
          input.status === 'PARTIALLY_COMPLETED'
        )
          stampCompleted = true;
      }
      if (input.denialBasis !== undefined) push('denial_basis', input.denialBasis);
      if (input.categoriesErased !== undefined)
        push('categories_erased', input.categoriesErased, '::text[]');
      if (input.categoriesRetained !== undefined)
        push('categories_retained', input.categoriesRetained, '::text[]');
      if (input.categoriesPseudonymised !== undefined)
        push('categories_pseudonymised', input.categoriesPseudonymised, '::text[]');
      if (input.notes !== undefined) push('notes', input.notes);
      if (stampCompleted && !lockedCompletedAt) {
        push('completed_at', new Date().toISOString(), '::timestamptz');
        push('reviewed_by', actor.accountId, '::uuid');
      }
      if (sets.length === 0) return;
      sets.push('updated_at = now()');
      params.push(id);
      params.push(tenant.schoolId);
      await tx.$executeRawUnsafe(
        `UPDATE dpo_erasure_requests SET ${sets.join(', ')} WHERE id = $${i}::uuid AND school_id = $${i + 1}::uuid`,
        ...params,
      );
    });
    return this.getById(actor, id);
  }

  /**
   * **AUDIT LOG PSEUDONYMISATION KEYSTONE.**
   *
   * Rewrites platform.platform_audit_log.metadata JSONB for rows where
   * the data subject appears as actor or entity, replacing the metadata
   * with the opaque pseudonymisation token. Writes one IMMUTABLE row
   * to dpo_pseudonymisation_log per (target_table, target_field).
   *
   * REVIEW-CYCLE30 BLOCKING 6 — atomic across both writes. The tenant
   * connection's search_path is `tenant_X, platform, public`, so the
   * UPDATE on platform.platform_audit_log AND the INSERT into
   * dpo_pseudonymisation_log run inside one tenant transaction. If
   * either fails the whole tx rolls back; the durable IMMUTABLE log
   * row and the platform mutation land together or not at all.
   *
   * REVIEW-CYCLE30 MAJOR 7 — the platform UPDATE is school-scoped via
   * `tenant_id = $schoolId` so a school-scoped DPO can only
   * pseudonymise audit rows for their own school's processing. The
   * org-scoped DPO model (Phase 2) generalises this to enumerate
   * every school in the org.
   */
  async pseudonymiseAuditLog(
    actor: ResolvedActor,
    erasureRequestId: string,
    input: PseudonymiseAuditDto,
  ): Promise<PseudonymisationLogDto> {
    if (!(await this.hasDpoScope(actor))) {
      throw new ForbiddenException(
        'Only the DPO can pseudonymise audit log records (dpo-004:write).',
      );
    }
    if (input.targetTable !== 'platform_audit_log') {
      throw new BadRequestException(
        'Only platform_audit_log is supported as a pseudonymisation target in this cycle.',
      );
    }
    if (input.targetField !== 'metadata') {
      throw new BadRequestException(
        'Only the metadata field on platform_audit_log is supported as a pseudonymisation target in this cycle.',
      );
    }
    const tenant = getCurrentTenant();
    const erasure = await this.getById(actor, erasureRequestId);
    const pseudonymisationToken = `psd_${generateId().replace(/-/g, '').slice(0, 16)}`;
    const replacement = JSON.stringify({ pseudonymised: pseudonymisationToken });
    const logId = generateId();

    // REVIEW-CYCLE30 BLOCKING 6 — atomic pseudonymisation.
    // Both writes happen inside one tenant tx. The tenant connection's
    // search_path is `tenant_X, platform, public`, so it can write to
    // platform.platform_audit_log via the schema-qualified path. If
    // either statement fails the whole tx rolls back — we cannot land
    // a platform mutation without a corresponding IMMUTABLE log row.
    //
    // REVIEW-CYCLE30 MAJOR 7 — narrow the platform UPDATE to audit
    // rows whose tenant_id matches the calling tenant. School-scoped
    // DPO actors only pseudonymise audit metadata for their own
    // school's audit rows; org-scoped DPO is Phase 2 and would
    // generalise the WHERE clause to span every school in the org.
    const updated = (await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rowsAffected = (await tx.$executeRawUnsafe(
        `UPDATE platform.platform_audit_log
            SET metadata = $1::jsonb
          WHERE tenant_id = $3::uuid
            AND (actor_id = $2::uuid OR (entity_type = 'iam_person' AND entity_id = $2::uuid))`,
        replacement,
        erasure.dataSubjectId,
        tenant.schoolId,
      )) as number;
      await tx.$executeRawUnsafe(
        `INSERT INTO dpo_pseudonymisation_log
         (id, school_id, erasure_request_id, data_subject_id, target_table, target_field, rows_pseudonymised, pseudonymisation_token, pseudonymised_by, notes)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9::uuid, $10)`,
        logId,
        tenant.schoolId,
        erasureRequestId,
        erasure.dataSubjectId,
        input.targetTable,
        input.targetField,
        rowsAffected,
        pseudonymisationToken,
        actor.accountId,
        `Replaced ${rowsAffected} platform.platform_audit_log.metadata rows with the pseudonymisation token.`,
      );
      return rowsAffected;
    })) as number;

    // Refresh the row to return it.
    // P2-H1 Step 1: school-scope the reload as defence-in-depth.
    const tenantForReload = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT * FROM dpo_pseudonymisation_log WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        logId,
        tenantForReload.schoolId,
      );
    })) as Array<Record<string, unknown>>;
    const row = rows[0]!;
    void updated;
    return {
      id: row.id as string,
      schoolId: row.school_id as string,
      erasureRequestId: row.erasure_request_id as string,
      dataSubjectId: row.data_subject_id as string,
      targetTable: row.target_table as string,
      targetField: row.target_field as string,
      rowsPseudonymised: row.rows_pseudonymised as number,
      pseudonymisationToken: row.pseudonymisation_token as string,
      pseudonymisedAt: (row.pseudonymised_at as Date).toISOString(),
      pseudonymisedById: row.pseudonymised_by as string,
      notes: (row.notes as string | null) ?? null,
    };
  }

  async listPseudonymisations(
    actor: ResolvedActor,
    erasureRequestId?: string,
  ): Promise<PseudonymisationLogDto[]> {
    if (!(await this.hasDpoScope(actor))) {
      throw new ForbiddenException(
        'Pseudonymisation log access is restricted to the DPO scope (dpo-004:write).',
      );
    }
    const tenant = getCurrentTenant();
    const where: string[] = ['school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (erasureRequestId) {
      where.push(`erasure_request_id = $${params.length + 1}::uuid`);
      params.push(erasureRequestId);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT * FROM dpo_pseudonymisation_log WHERE ${where.join(' AND ')} ORDER BY pseudonymised_at DESC`,
        ...params,
      );
    })) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      schoolId: r.school_id as string,
      erasureRequestId: r.erasure_request_id as string,
      dataSubjectId: r.data_subject_id as string,
      targetTable: r.target_table as string,
      targetField: r.target_field as string,
      rowsPseudonymised: r.rows_pseudonymised as number,
      pseudonymisationToken: r.pseudonymisation_token as string,
      pseudonymisedAt: (r.pseudonymised_at as Date).toISOString(),
      pseudonymisedById: r.pseudonymised_by as string,
      notes: (r.notes as string | null) ?? null,
    }));
  }
}

@Injectable()
export class ConsentService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
    private readonly access: GovernanceAccess,
  ) {}

  private async hasDpoScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'dpo-005:write',
    ]);
  }

  private async hasReadScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'dpo-005:read',
    ]);
  }

  private rowToConsentDto(
    r: Record<string, unknown>,
    activityName: string | null,
  ): ConsentRecordDto {
    return {
      id: r.id as string,
      schoolId: r.school_id as string,
      dataSubjectId: r.data_subject_id as string,
      processingActivityId: r.processing_activity_id as string,
      processingActivityName: activityName,
      consented: r.consented as boolean,
      consentMethod: r.consent_method as ConsentRecordDto['consentMethod'],
      consentGivenAt: (r.consent_given_at as Date | null)?.toISOString() ?? null,
      consentWithdrawnAt: (r.consent_withdrawn_at as Date | null)?.toISOString() ?? null,
      evidenceS3Key: (r.evidence_s3_key as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
      createdAt: (r.created_at as Date).toISOString(),
      updatedAt: (r.updated_at as Date).toISOString(),
    };
  }

  async list(
    actor: ResolvedActor,
    args?: { dataSubjectId?: string; processingActivityId?: string; consentedOnly?: boolean },
  ): Promise<ConsentRecordDto[]> {
    if (!(await this.hasReadScope(actor))) {
      throw new ForbiddenException('Consent records access requires dpo-005:read.');
    }
    const tenant = getCurrentTenant();
    const where: string[] = ['c.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (args?.dataSubjectId) {
      where.push(`c.data_subject_id = $${params.length + 1}::uuid`);
      params.push(args.dataSubjectId);
    }
    if (args?.processingActivityId) {
      where.push(`c.processing_activity_id = $${params.length + 1}::uuid`);
      params.push(args.processingActivityId);
    }
    if (args?.consentedOnly) where.push('c.consented = true AND c.consent_withdrawn_at IS NULL');
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT c.*, pa.activity_name AS processing_activity_name
           FROM dpo_processing_consent_records c
           LEFT JOIN dpo_processing_activities pa ON pa.id = c.processing_activity_id
          WHERE ${where.join(' AND ')}
          ORDER BY c.consent_given_at DESC NULLS LAST`,
        ...params,
      );
    })) as Array<Record<string, unknown>>;
    return rows.map((r) =>
      this.rowToConsentDto(r, (r.processing_activity_name as string | null) ?? null),
    );
  }

  async create(actor: ResolvedActor, input: CreateConsentDto): Promise<ConsentRecordDto> {
    if (!(await this.hasDpoScope(actor))) {
      throw new ForbiddenException('Only the DPO can record consent (dpo-005:write).');
    }
    // REVIEW-CYCLE30 BLOCKING 4 — validate the data subject + the
    // processing activity. Consent records cannot reference platform
    // people from other tenants, nonexistent activities, or activities
    // flagged is_active=false (consent records are time-bound to active
    // processing per ADR-052; documenting consent on a deprecated
    // activity is meaningless for the audit ledger).
    await this.access.assertDataSubjectInCurrentTenant(input.dataSubjectId);
    await this.access.assertProcessingActivityInCurrentSchool(input.processingActivityId, {
      requireActive: true,
    });
    const tenant = getCurrentTenant();
    const id = generateId();
    const givenAt = input.consented ? (input.consentGivenAt ?? new Date().toISOString()) : null;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO dpo_processing_consent_records
         (id, school_id, data_subject_id, processing_activity_id, consented, consent_method, consent_given_at, evidence_s3_key, notes)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::timestamptz, $8, $9)`,
        id,
        tenant.schoolId,
        input.dataSubjectId,
        input.processingActivityId,
        input.consented,
        input.consentMethod,
        givenAt,
        input.evidenceS3Key ?? null,
        input.notes ?? null,
      );
    });
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT c.*, pa.activity_name AS processing_activity_name
           FROM dpo_processing_consent_records c
           LEFT JOIN dpo_processing_activities pa ON pa.id = c.processing_activity_id
          WHERE c.id = $1::uuid`,
        id,
      );
    })) as Array<Record<string, unknown>>;
    return this.rowToConsentDto(
      rows[0]!,
      (rows[0]!.processing_activity_name as string | null) ?? null,
    );
  }

  async withdraw(
    actor: ResolvedActor,
    id: string,
    input: WithdrawConsentDto,
  ): Promise<ConsentRecordDto> {
    if (!(await this.hasDpoScope(actor))) {
      throw new ForbiddenException('Only the DPO can withdraw consent (dpo-005:write).');
    }
    const tenant = getCurrentTenant();
    const withdrawnAt = input.withdrawnAt ?? new Date().toISOString();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const result = await tx.$executeRawUnsafe(
        `UPDATE dpo_processing_consent_records
         SET consented = false, consent_withdrawn_at = $1::timestamptz, notes = COALESCE($2, notes), updated_at = now()
         WHERE id = $3::uuid AND school_id = $4::uuid AND consent_withdrawn_at IS NULL`,
        withdrawnAt,
        input.notes ?? null,
        id,
        tenant.schoolId,
      );
      if (result === 0) {
        throw new BadRequestException(`Consent record ${id} not found or already withdrawn.`);
      }
    });
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT c.*, pa.activity_name AS processing_activity_name
           FROM dpo_processing_consent_records c
           LEFT JOIN dpo_processing_activities pa ON pa.id = c.processing_activity_id
          WHERE c.id = $1::uuid`,
        id,
      );
    })) as Array<Record<string, unknown>>;
    return this.rowToConsentDto(
      rows[0]!,
      (rows[0]!.processing_activity_name as string | null) ?? null,
    );
  }
}

@Injectable()
export class PrivacyNoticeService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  private async hasDpoWrite(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'dpo-005:write',
    ]);
  }

  private async resolveAccountName(accountId: string | null): Promise<string | null> {
    if (!accountId) return null;
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT ip.first_name || ' ' || ip.last_name AS name
           FROM platform.platform_users pu
           JOIN platform.iam_person ip ON ip.id = pu.person_id
          WHERE pu.id = $1::uuid LIMIT 1`,
        accountId,
      );
    })) as Array<{ name: string }>;
    return rows[0]?.name ?? null;
  }

  private rowToNoticeDto(r: Record<string, unknown>, name: string | null): PrivacyNoticeDto {
    return {
      id: r.id as string,
      schoolId: r.school_id as string,
      noticeVersion: r.notice_version as string,
      effectiveFrom: String(r.effective_from).slice(0, 10),
      contentSummary: r.content_summary as string,
      documentS3Key: r.document_s3_key as string,
      publishedById: r.published_by as string,
      publishedByName: name,
      publishedAt: (r.published_at as Date | null)?.toISOString() ?? null,
      supersededAt: (r.superseded_at as Date | null)?.toISOString() ?? null,
      isCurrent: !r.superseded_at,
      createdAt: (r.created_at as Date).toISOString(),
      updatedAt: (r.updated_at as Date).toISOString(),
    };
  }

  async list(_actor: ResolvedActor): Promise<PrivacyNoticeDto[]> {
    // Privacy notices are intentionally world-readable to authenticated
    // users; even data subjects need to see them.
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT * FROM dpo_privacy_notices WHERE school_id = $1::uuid ORDER BY effective_from DESC`,
        tenant.schoolId,
      );
    })) as Array<Record<string, unknown>>;
    const out: PrivacyNoticeDto[] = [];
    for (const r of rows) {
      const name = await this.resolveAccountName(r.published_by as string);
      out.push(this.rowToNoticeDto(r, name));
    }
    return out;
  }

  async getCurrent(_actor: ResolvedActor): Promise<PrivacyNoticeDto | null> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT * FROM dpo_privacy_notices
          WHERE school_id = $1::uuid AND superseded_at IS NULL AND published_at IS NOT NULL
          ORDER BY effective_from DESC LIMIT 1`,
        tenant.schoolId,
      );
    })) as Array<Record<string, unknown>>;
    if (rows.length === 0) return null;
    const name = await this.resolveAccountName(rows[0]!.published_by as string);
    return this.rowToNoticeDto(rows[0]!, name);
  }

  async create(actor: ResolvedActor, input: CreatePrivacyNoticeDto): Promise<PrivacyNoticeDto> {
    if (!(await this.hasDpoWrite(actor))) {
      throw new ForbiddenException('Only the DPO can create privacy notices (dpo-005:write).');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO dpo_privacy_notices
           (id, school_id, notice_version, effective_from, content_summary, document_s3_key, published_by, published_at, superseded_at)
           VALUES ($1::uuid, $2::uuid, $3, $4::date, $5, $6, $7::uuid, NULL, NULL)`,
          id,
          tenant.schoolId,
          input.noticeVersion,
          input.effectiveFrom,
          input.contentSummary,
          input.documentS3Key,
          actor.accountId,
        );
      });
    } catch (err) {
      const e = err as { code?: string; meta?: { code?: string }; message?: string };
      if (
        e?.code === '23505' ||
        e?.meta?.code === '23505' ||
        /23505|duplicate key/.test(e?.message ?? '')
      ) {
        throw new BadRequestException(
          `Privacy notice version "${input.noticeVersion}" already exists for this school.`,
        );
      }
      throw err;
    }
    // P2-H1 Step 1: school-scope the reload — defence-in-depth.
    const reloadTenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT * FROM dpo_privacy_notices WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        id,
        reloadTenant.schoolId,
      );
    })) as Array<Record<string, unknown>>;
    const name = await this.resolveAccountName(rows[0]!.published_by as string);
    return this.rowToNoticeDto(rows[0]!, name);
  }

  /**
   * Publishing flips published_at on the target notice and supersedes
   * every prior published notice for the school in one tx, so the
   * "current notice" query returns exactly one row.
   */
  async publish(
    actor: ResolvedActor,
    id: string,
    input: PublishPrivacyNoticeDto,
  ): Promise<PrivacyNoticeDto> {
    if (!(await this.hasDpoWrite(actor))) {
      throw new ForbiddenException('Only the DPO can publish privacy notices (dpo-005:write).');
    }
    const tenant = getCurrentTenant();
    const publishedAt = input.publishedAt ?? new Date().toISOString();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE dpo_privacy_notices
         SET superseded_at = $1::timestamptz, updated_at = now()
         WHERE school_id = $2::uuid AND id <> $3::uuid AND superseded_at IS NULL AND published_at IS NOT NULL`,
        publishedAt,
        tenant.schoolId,
        id,
      );
      const result = await tx.$executeRawUnsafe(
        `UPDATE dpo_privacy_notices
         SET published_at = $1::timestamptz, superseded_at = NULL, updated_at = now()
         WHERE id = $2::uuid AND school_id = $3::uuid`,
        publishedAt,
        id,
        tenant.schoolId,
      );
      if (result === 0) throw new NotFoundException(`Privacy notice ${id} not found.`);
    });
    // P2-H1 Step 1: school-scope the reload — defence-in-depth.
    const reloadTenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT * FROM dpo_privacy_notices WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        id,
        reloadTenant.schoolId,
      );
    })) as Array<Record<string, unknown>>;
    const name = await this.resolveAccountName(rows[0]!.published_by as string);
    return this.rowToNoticeDto(rows[0]!, name);
  }
}

@Injectable()
export class ComplianceConfigService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  private async hasDpoAdmin(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'dpo-001:admin',
      'dpo-005:admin',
    ]);
  }

  private rowToConfigDto(r: Record<string, unknown>): ComplianceConfigDto {
    return {
      id: r.id as string,
      schoolId: r.school_id as string,
      sarDefaultDeadlineDays: r.sar_default_deadline_days as number,
      breachEscalationHours: r.breach_escalation_hours as number,
      retentionReviewReminderDays: r.retention_review_reminder_days as number,
      dpaReviewReminderDays: r.dpa_review_reminder_days as number,
      dpiaReviewReminderDays: r.dpia_review_reminder_days as number,
      notes: (r.notes as string | null) ?? null,
      createdAt: (r.created_at as Date).toISOString(),
      updatedAt: (r.updated_at as Date).toISOString(),
    };
  }

  async get(_actor: ResolvedActor): Promise<ComplianceConfigDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT * FROM dpo_compliance_dashboard_config WHERE school_id = $1::uuid LIMIT 1`,
        tenant.schoolId,
      );
    })) as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      // Auto-create the default row on first read.
      const id = generateId();
      await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO dpo_compliance_dashboard_config (id, school_id) VALUES ($1::uuid, $2::uuid)`,
          id,
          tenant.schoolId,
        );
      });
      return this.get(_actor);
    }
    return this.rowToConfigDto(rows[0]!);
  }

  async update(
    actor: ResolvedActor,
    input: UpdateComplianceConfigDto,
  ): Promise<ComplianceConfigDto> {
    if (!(await this.hasDpoAdmin(actor))) {
      throw new ForbiddenException(
        'Only the DPO admin can mutate compliance settings (dpo-001:admin OR dpo-005:admin).',
      );
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    const push = (col: string, val: unknown) => {
      sets.push(`${col} = $${i}`);
      params.push(val);
      i++;
    };
    if (input.sarDefaultDeadlineDays !== undefined)
      push('sar_default_deadline_days', input.sarDefaultDeadlineDays);
    if (input.breachEscalationHours !== undefined)
      push('breach_escalation_hours', input.breachEscalationHours);
    if (input.retentionReviewReminderDays !== undefined)
      push('retention_review_reminder_days', input.retentionReviewReminderDays);
    if (input.dpaReviewReminderDays !== undefined)
      push('dpa_review_reminder_days', input.dpaReviewReminderDays);
    if (input.dpiaReviewReminderDays !== undefined)
      push('dpia_review_reminder_days', input.dpiaReviewReminderDays);
    if (input.notes !== undefined) push('notes', input.notes);
    if (sets.length === 0) return this.get(actor);
    sets.push('updated_at = now()');
    const tenant = getCurrentTenant();
    params.push(tenant.schoolId);
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const result = await tx.$executeRawUnsafe(
        `UPDATE dpo_compliance_dashboard_config SET ${sets.join(', ')} WHERE school_id = $${i}::uuid`,
        ...params,
      );
      if (result === 0) {
        // The compliance config doesn't exist yet — auto-create it then re-apply.
        const id = generateId();
        await tx.$executeRawUnsafe(
          `INSERT INTO dpo_compliance_dashboard_config (id, school_id) VALUES ($1::uuid, $2::uuid)`,
          id,
          tenant.schoolId,
        );
        await tx.$executeRawUnsafe(
          `UPDATE dpo_compliance_dashboard_config SET ${sets.join(', ')} WHERE school_id = $${i}::uuid`,
          ...params,
        );
      }
    });
    return this.get(actor);
  }
}
