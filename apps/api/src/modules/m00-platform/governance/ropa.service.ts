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
import type {
  CreateProcessingActivityDto,
  CreateRetentionPolicyDto,
  ProcessingActivityDto,
  RetentionPolicyDto,
  UpdateProcessingActivityDto,
  UpdateRetentionPolicyDto,
} from './dto/governance.dto';

/**
 * RopaService — GDPR Article 30 Register of Processing Activities +
 * per-(school, data_category) retention policies.
 *
 * "DPO scope" = school admin OR holds dpo-001:write. Read tier opens
 * up to dpo-001:read holders. Surfaces gap rows on the compliance
 * dashboard via the `hasDpiaGap` flag (high_risk_processing=true AND
 * dpia_id IS NULL) and the `reviewDue` flag on retention policies
 * (next_review_date <= today + reminder_days).
 */
@Injectable()
export class RopaService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  async assertDpoReadScope(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'dpo-001:read',
    ]);
    if (!ok) {
      throw new ForbiddenException(
        'Records of Processing access is restricted to the DPO scope (dpo-001:read).',
      );
    }
  }

  async assertDpoWriteScope(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'dpo-001:write',
    ]);
    if (!ok) {
      throw new ForbiddenException(
        'Only the DPO can mutate ROPA / retention policies (dpo-001:write).',
      );
    }
  }

  async assertDpoAdminScope(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'dpo-001:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException(
        'Only the DPO admin can hard-delete ROPA / retention rows (dpo-001:admin).',
      );
    }
  }

  // ─── ROPA ─────────────────────────────────────────────────────────

  private rowToProcessingActivityDto(r: Record<string, unknown>): ProcessingActivityDto {
    return {
      id: r.id as string,
      schoolId: r.school_id as string,
      activityName: r.activity_name as string,
      purpose: r.purpose as string,
      legalBasis: r.legal_basis as ProcessingActivityDto['legalBasis'],
      dataCategories: (r.data_categories as string[]) ?? [],
      dataSubjects: (r.data_subjects as string[]) ?? [],
      retentionPolicyId: (r.retention_policy_id as string | null) ?? null,
      retentionPolicyCategory: (r.retention_policy_category as string | null) ?? null,
      transfersOutsideUkEea: r.transfers_outside_uk_eea as boolean,
      transferSafeguards: (r.transfer_safeguards as string | null) ?? null,
      automatedDecisionMaking: r.automated_decision_making as boolean,
      profiling: r.profiling as boolean,
      highRiskProcessing: r.high_risk_processing as boolean,
      dpiaId: (r.dpia_id as string | null) ?? null,
      dpiaTitle: (r.dpia_title as string | null) ?? null,
      hasDpiaGap: r.high_risk_processing === true && (r.dpia_id ?? null) === null,
      isActive: r.is_active as boolean,
      lastReviewedAt: r.last_reviewed_at ? String(r.last_reviewed_at).slice(0, 10) : null,
      reviewedById: (r.reviewed_by as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
      createdAt: (r.created_at as Date).toISOString(),
      updatedAt: (r.updated_at as Date).toISOString(),
    };
  }

  async listProcessingActivities(
    actor: ResolvedActor,
    args?: { includeInactive?: boolean; gapsOnly?: boolean },
  ): Promise<ProcessingActivityDto[]> {
    await this.assertDpoReadScope(actor);
    const tenant = getCurrentTenant();
    const where: string[] = ['pa.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (!args?.includeInactive) where.push('pa.is_active = true');
    if (args?.gapsOnly) where.push('pa.high_risk_processing = true AND pa.dpia_id IS NULL');
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT pa.*, rp.data_category AS retention_policy_category, dp.dpia_title
           FROM dpo_processing_activities pa
           LEFT JOIN dpo_retention_policies rp ON rp.id = pa.retention_policy_id
           LEFT JOIN dpo_dpias dp ON dp.id = pa.dpia_id
          WHERE ${where.join(' AND ')}
          ORDER BY pa.high_risk_processing DESC, pa.activity_name ASC`,
        ...params,
      );
    })) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToProcessingActivityDto(r));
  }

  async getProcessingActivity(actor: ResolvedActor, id: string): Promise<ProcessingActivityDto> {
    await this.assertDpoReadScope(actor);
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT pa.*, rp.data_category AS retention_policy_category, dp.dpia_title
           FROM dpo_processing_activities pa
           LEFT JOIN dpo_retention_policies rp ON rp.id = pa.retention_policy_id
           LEFT JOIN dpo_dpias dp ON dp.id = pa.dpia_id
          WHERE pa.id = $1::uuid AND pa.school_id = $2::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      );
    })) as Array<Record<string, unknown>>;
    if (rows.length === 0) throw new NotFoundException(`Processing activity ${id} not found.`);
    return this.rowToProcessingActivityDto(rows[0]!);
  }

  private async assertRetentionPolicyExists(
    retentionPolicyId: string | null | undefined,
  ): Promise<void> {
    if (!retentionPolicyId) return;
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT 1 AS x FROM dpo_retention_policies WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        retentionPolicyId,
        tenant.schoolId,
      );
    })) as Array<unknown>;
    if (rows.length === 0) {
      throw new BadRequestException(
        `retentionPolicyId ${retentionPolicyId} does not match a retention policy in this school.`,
      );
    }
  }

  private async assertDpiaExists(dpiaId: string | null | undefined): Promise<void> {
    if (!dpiaId) return;
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT 1 AS x FROM dpo_dpias WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        dpiaId,
        tenant.schoolId,
      );
    })) as Array<unknown>;
    if (rows.length === 0) {
      throw new BadRequestException(`dpiaId ${dpiaId} does not match a DPIA in this school.`);
    }
  }

  async createProcessingActivity(
    actor: ResolvedActor,
    input: CreateProcessingActivityDto,
  ): Promise<ProcessingActivityDto> {
    await this.assertDpoWriteScope(actor);
    if (input.dataCategories.length === 0) {
      throw new BadRequestException('dataCategories must contain at least one entry.');
    }
    if (input.dataSubjects.length === 0) {
      throw new BadRequestException('dataSubjects must contain at least one entry.');
    }
    await this.assertRetentionPolicyExists(input.retentionPolicyId);
    await this.assertDpiaExists(input.dpiaId);
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO dpo_processing_activities
           (id, school_id, activity_name, purpose, legal_basis, data_categories, data_subjects,
            retention_policy_id, transfers_outside_uk_eea, transfer_safeguards,
            automated_decision_making, profiling, high_risk_processing, dpia_id, is_active,
            reviewed_by, notes)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::text[], $7::text[], $8::uuid, $9, $10, $11, $12, $13, $14::uuid, true, $15::uuid, $16)`,
          id,
          tenant.schoolId,
          input.activityName,
          input.purpose,
          input.legalBasis,
          input.dataCategories,
          input.dataSubjects,
          input.retentionPolicyId ?? null,
          input.transfersOutsideUkEea ?? false,
          input.transferSafeguards ?? null,
          input.automatedDecisionMaking ?? false,
          input.profiling ?? false,
          input.highRiskProcessing ?? false,
          input.dpiaId ?? null,
          actor.accountId,
          input.notes ?? null,
        );
      });
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new BadRequestException(
          `A processing activity named "${input.activityName}" already exists for this school.`,
        );
      }
      throw err;
    }
    return this.getProcessingActivity(actor, id);
  }

  async updateProcessingActivity(
    actor: ResolvedActor,
    id: string,
    input: UpdateProcessingActivityDto,
  ): Promise<ProcessingActivityDto> {
    await this.assertDpoWriteScope(actor);
    if (input.dataCategories && input.dataCategories.length === 0) {
      throw new BadRequestException('dataCategories must contain at least one entry.');
    }
    if (input.dataSubjects && input.dataSubjects.length === 0) {
      throw new BadRequestException('dataSubjects must contain at least one entry.');
    }
    if (input.retentionPolicyId !== undefined && input.retentionPolicyId !== null) {
      await this.assertRetentionPolicyExists(input.retentionPolicyId);
    }
    if (input.dpiaId !== undefined && input.dpiaId !== null) {
      await this.assertDpiaExists(input.dpiaId);
    }
    const tenant = getCurrentTenant();
    const existing = await this.getProcessingActivity(actor, id);
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    const push = (col: string, val: unknown, cast?: string) => {
      sets.push(`${col} = $${i}${cast ?? ''}`);
      params.push(val);
      i++;
    };
    if (input.activityName !== undefined) push('activity_name', input.activityName);
    if (input.purpose !== undefined) push('purpose', input.purpose);
    if (input.legalBasis !== undefined) push('legal_basis', input.legalBasis);
    if (input.dataCategories !== undefined)
      push('data_categories', input.dataCategories, '::text[]');
    if (input.dataSubjects !== undefined) push('data_subjects', input.dataSubjects, '::text[]');
    if (input.retentionPolicyId !== undefined)
      push('retention_policy_id', input.retentionPolicyId, '::uuid');
    if (input.transfersOutsideUkEea !== undefined)
      push('transfers_outside_uk_eea', input.transfersOutsideUkEea);
    if (input.transferSafeguards !== undefined)
      push('transfer_safeguards', input.transferSafeguards);
    if (input.automatedDecisionMaking !== undefined)
      push('automated_decision_making', input.automatedDecisionMaking);
    if (input.profiling !== undefined) push('profiling', input.profiling);
    if (input.highRiskProcessing !== undefined)
      push('high_risk_processing', input.highRiskProcessing);
    if (input.dpiaId !== undefined) push('dpia_id', input.dpiaId, '::uuid');
    if (input.isActive !== undefined) push('is_active', input.isActive);
    if (input.lastReviewedAt !== undefined)
      push('last_reviewed_at', input.lastReviewedAt, '::date');
    if (input.notes !== undefined) push('notes', input.notes);
    if (sets.length === 0) return existing;
    sets.push('updated_at = now()');
    sets.push(`reviewed_by = $${i}::uuid`);
    params.push(actor.accountId);
    i++;
    params.push(id);
    params.push(tenant.schoolId);
    try {
      await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE dpo_processing_activities SET ${sets.join(', ')} WHERE id = $${i}::uuid AND school_id = $${i + 1}::uuid`,
          ...params,
        );
      });
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new BadRequestException(
          `A processing activity with that name already exists for this school.`,
        );
      }
      throw err;
    }
    return this.getProcessingActivity(actor, id);
  }

  async deleteProcessingActivity(actor: ResolvedActor, id: string): Promise<void> {
    await this.assertDpoAdminScope(actor);
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const result = await tx.$executeRawUnsafe(
        `DELETE FROM dpo_processing_activities WHERE id = $1::uuid AND school_id = $2::uuid`,
        id,
        tenant.schoolId,
      );
      if (result === 0) throw new NotFoundException(`Processing activity ${id} not found.`);
    });
  }

  // ─── Retention Policies ───────────────────────────────────────────

  private rowToRetentionPolicyDto(
    r: Record<string, unknown>,
    reminderDays: number,
  ): RetentionPolicyDto {
    const next = String(r.next_review_date).slice(0, 10);
    const nextMs = new Date(next + 'T00:00:00Z').getTime();
    const reminderMs = Date.now() + reminderDays * 24 * 60 * 60 * 1000;
    return {
      id: r.id as string,
      schoolId: r.school_id as string,
      dataCategory: r.data_category as string,
      retentionPeriod: r.retention_period as string,
      legalBasisForRetention: r.legal_basis_for_retention as string,
      reviewFrequency: r.review_frequency as RetentionPolicyDto['reviewFrequency'],
      lastReviewedAt: r.last_reviewed_at ? String(r.last_reviewed_at).slice(0, 10) : null,
      nextReviewDate: next,
      reviewedById: (r.reviewed_by as string | null) ?? null,
      linksToArchiveTier: (r.links_to_archive_tier as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
      reviewDue: nextMs <= reminderMs,
      createdAt: (r.created_at as Date).toISOString(),
      updatedAt: (r.updated_at as Date).toISOString(),
    };
  }

  private async getReviewReminderDays(): Promise<number> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT retention_review_reminder_days FROM dpo_compliance_dashboard_config WHERE school_id = $1::uuid LIMIT 1`,
        tenant.schoolId,
      );
    })) as Array<{ retention_review_reminder_days: number }>;
    return rows[0]?.retention_review_reminder_days ?? 30;
  }

  async listRetentionPolicies(
    actor: ResolvedActor,
    args?: { dueOnly?: boolean },
  ): Promise<RetentionPolicyDto[]> {
    await this.assertDpoReadScope(actor);
    const tenant = getCurrentTenant();
    const reminder = await this.getReviewReminderDays();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      const sql = args?.dueOnly
        ? `SELECT * FROM dpo_retention_policies WHERE school_id = $1::uuid AND next_review_date <= CURRENT_DATE + ($2 || ' days')::interval ORDER BY next_review_date ASC`
        : `SELECT * FROM dpo_retention_policies WHERE school_id = $1::uuid ORDER BY data_category ASC`;
      const params = args?.dueOnly ? [tenant.schoolId, String(reminder)] : [tenant.schoolId];
      return client.$queryRawUnsafe(sql, ...params);
    })) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToRetentionPolicyDto(r, reminder));
  }

  async getRetentionPolicy(actor: ResolvedActor, id: string): Promise<RetentionPolicyDto> {
    await this.assertDpoReadScope(actor);
    const tenant = getCurrentTenant();
    const reminder = await this.getReviewReminderDays();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT * FROM dpo_retention_policies WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      );
    })) as Array<Record<string, unknown>>;
    if (rows.length === 0) throw new NotFoundException(`Retention policy ${id} not found.`);
    return this.rowToRetentionPolicyDto(rows[0]!, reminder);
  }

  async createRetentionPolicy(
    actor: ResolvedActor,
    input: CreateRetentionPolicyDto,
  ): Promise<RetentionPolicyDto> {
    await this.assertDpoWriteScope(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO dpo_retention_policies
           (id, school_id, data_category, retention_period, legal_basis_for_retention, review_frequency, next_review_date, reviewed_by, links_to_archive_tier, notes)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::date, $8::uuid, $9, $10)`,
          id,
          tenant.schoolId,
          input.dataCategory,
          input.retentionPeriod,
          input.legalBasisForRetention,
          input.reviewFrequency ?? 'ANNUAL',
          input.nextReviewDate,
          actor.accountId,
          input.linksToArchiveTier ?? null,
          input.notes ?? null,
        );
      });
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new BadRequestException(
          `A retention policy for category "${input.dataCategory}" already exists for this school.`,
        );
      }
      throw err;
    }
    return this.getRetentionPolicy(actor, id);
  }

  async updateRetentionPolicy(
    actor: ResolvedActor,
    id: string,
    input: UpdateRetentionPolicyDto,
  ): Promise<RetentionPolicyDto> {
    await this.assertDpoWriteScope(actor);
    const existing = await this.getRetentionPolicy(actor, id);
    const tenant = getCurrentTenant();
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    const push = (col: string, val: unknown, cast?: string) => {
      sets.push(`${col} = $${i}${cast ?? ''}`);
      params.push(val);
      i++;
    };
    if (input.dataCategory !== undefined) push('data_category', input.dataCategory);
    if (input.retentionPeriod !== undefined) push('retention_period', input.retentionPeriod);
    if (input.legalBasisForRetention !== undefined)
      push('legal_basis_for_retention', input.legalBasisForRetention);
    if (input.reviewFrequency !== undefined) push('review_frequency', input.reviewFrequency);
    if (input.lastReviewedAt !== undefined)
      push('last_reviewed_at', input.lastReviewedAt, '::date');
    if (input.nextReviewDate !== undefined)
      push('next_review_date', input.nextReviewDate, '::date');
    if (input.linksToArchiveTier !== undefined)
      push('links_to_archive_tier', input.linksToArchiveTier);
    if (input.notes !== undefined) push('notes', input.notes);
    if (sets.length === 0) return existing;
    sets.push('updated_at = now()');
    sets.push(`reviewed_by = $${i}::uuid`);
    params.push(actor.accountId);
    i++;
    params.push(id);
    params.push(tenant.schoolId);
    try {
      await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE dpo_retention_policies SET ${sets.join(', ')} WHERE id = $${i}::uuid AND school_id = $${i + 1}::uuid`,
          ...params,
        );
      });
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new BadRequestException(
          `A retention policy for that data category already exists for this school.`,
        );
      }
      throw err;
    }
    return this.getRetentionPolicy(actor, id);
  }

  async deleteRetentionPolicy(actor: ResolvedActor, id: string): Promise<void> {
    await this.assertDpoAdminScope(actor);
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const result = await tx.$executeRawUnsafe(
        `DELETE FROM dpo_retention_policies WHERE id = $1::uuid AND school_id = $2::uuid`,
        id,
        tenant.schoolId,
      );
      if (result === 0) throw new NotFoundException(`Retention policy ${id} not found.`);
    });
  }

  private isUniqueViolation(err: unknown): boolean {
    const e = err as { code?: string; meta?: { code?: string }; message?: string };
    if (e?.code === '23505') return true;
    if (e?.meta?.code === '23505') return true;
    if (typeof e?.message === 'string' && /23505|duplicate key/.test(e.message)) return true;
    return false;
  }
}
